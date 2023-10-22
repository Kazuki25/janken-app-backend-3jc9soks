import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigateway from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from "aws-cdk-lib/aws-s3";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";

import * as config from '../lib/config.json';

export class JankenService extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    const name = id + "-janken-api";

    // Web client layer
    const bucket = new s3.Bucket(this, 'JankenGameBucket', {
      bucketName: 'janken-game-webapp',
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Serverless layer
    // Initialise queue.
    const queue = new sqs.Queue(this, 'WaitingQueue', {
      visibilityTimeout: cdk.Duration.seconds(5),
      retentionPeriod: cdk.Duration.seconds(60)
    });

    // Initialise api
    const api = new apigateway.CfnApi(this, name, {
      name: "JankenGameAPI",
      protocolType: "WEBSOCKET",
      routeSelectionExpression: "$request.body.action",
    });


    // Initialise dynamodb
    const connTable = new dynamodb.Table(this, `${name}-connections-table`, {
      tableName: "user-connections",
      partitionKey: {
        name: "connectionId",
        type: dynamodb.AttributeType.STRING,
      },
      readCapacity: 1,
      writeCapacity: 1,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const gameTable = new dynamodb.Table(this, `${name}-gamesessions-table`, {
      tableName: "game-sessions",
      partitionKey: {
        name: "gameId",
        type: dynamodb.AttributeType.STRING
      },
      readCapacity: 1,
      writeCapacity: 1,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Setup functions.
    const connectFunc = new lambda.Function(this, 'Connect-lambda', {
      code: lambda.Code.fromAsset("resources/onconnect"),
      handler: "app.handler",
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.seconds(3),
      memorySize: 128,
      environment: {
        "TABLE_NAME": connTable.tableName,
      }
    });

    connTable.grantReadWriteData(connectFunc);

    const disconnectFunc = new lambda.Function(this, 'Disconnect-lambda', {
      code: lambda.Code.fromAsset("resources/ondisconnect"),
      handler: "app.handler",
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.seconds(3),
      memorySize: 128,
      environment: {
        "TABLE_NAME": connTable.tableName
      }
    });

    connTable.grantReadWriteData(disconnectFunc);

    const getconnectionIdFunc = new lambda.Function(this, "Get-connectionId-lambda", {
      code: lambda.Code.fromAsset("resources/getconnectionid"),
      handler: "app.handler",
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.seconds(3),
      memorySize: 128,
    });

    const connectApiExecutePolicy = new PolicyStatement({
      actions: [
        'execute-api:ManageConnections'
      ],
      resources: [
        "arn:aws:execute-api:" + config["region"] + ":" + config["account_id"] + ":" + api.ref + "/*"
      ],
      effect: Effect.ALLOW
    })

    const gameFunc = new lambda.Function(this, 'Game-lambda', {
      code: lambda.Code.fromAsset("resources/game_function"),
      handler: "game.handler",
      // layers: [gameFuncLayer],
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.seconds(300),
      memorySize: 128,
      initialPolicy: [
        connectApiExecutePolicy
      ],
      environment: {
        "TABLE_NAME": gameTable.tableName,
        "QUEUE_URL": queue.queueUrl,
      }
    });

    gameTable.grantReadWriteData(gameFunc);
    queue.grantConsumeMessages(gameFunc);
    queue.grantSendMessages(gameFunc);

    const relayFunc = new lambda.Function(this, "Relay-lambda", {
      code: lambda.Code.fromAsset("resources/relay"),
      handler: "relay.handler",
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      initialPolicy: [connectApiExecutePolicy],
      environment: {
        "TABLE_NAME": gameTable.tableName,
      }
    })

    gameTable.grantReadData(relayFunc);

    // access role for the socket api to access the socket lambda
    const policy = new PolicyStatement({
      effect: Effect.ALLOW,
      resources: [
        connectFunc.functionArn,
        disconnectFunc.functionArn,
        gameFunc.functionArn,
        getconnectionIdFunc.functionArn,
        relayFunc.functionArn,
      ],
      actions: ["lambda:InvokeFunction"],
    });

    const role = new Role(this, `${name}-iam-role`, {
      assumedBy: new ServicePrincipal("apigateway.amazonaws.com")
    });
    role.addToPolicy(policy);

    // lambda integration
    const connectIntegration = new apigateway.CfnIntegration(this, "connect-lambda-integration", {
      apiId: api.ref,
      integrationType: "AWS_PROXY",
      integrationUri: "arn:aws:apigateway:" + config["region"] + ":lambda:path/2015-03-31/functions/" + connectFunc.functionArn + "/invocations",
      credentialsArn: role.roleArn,
    });

    const disconnectIntegration = new apigateway.CfnIntegration(this, "disconnect-lambda-itegration", {
      apiId: api.ref,
      integrationType: "AWS_PROXY",
      integrationUri: "arn:aws:apigateway:" + config["region"] + ":lambda:path/2015-03-31/functions/" + disconnectFunc.functionArn + "/invocations",
      credentialsArn: role.roleArn,
    });

    const getconnectionidIntegration = new apigateway.CfnIntegration(this, "getconnectionid-lambda-integration", {
      apiId: api.ref,
      integrationType: "AWS_PROXY",
      integrationUri: "arn:aws:apigateway:" + config["region"] + ":lambda:path/2015-03-31/functions/" + getconnectionIdFunc.functionArn + "/invocations",
      credentialsArn: role.roleArn,
    });

    const getconnectionidIntegrationResponse = new apigateway.CfnIntegrationResponse(this, "getconnection-response", {
      apiId: api.ref,
      integrationId: getconnectionidIntegration.ref,
      integrationResponseKey: "$default",
    });

    const gameAppIntegration = new apigateway.CfnIntegration(this, "game-lambda-integration", {
      apiId: api.ref,
      integrationType: "AWS_PROXY",
      integrationUri: "arn:aws:apigateway:" + config["region"] + ":lambda:path/2015-03-31/functions/" + gameFunc.functionArn + "/invocations",
      credentialsArn: role.roleArn,
    });

    const gameAppIntegrationResponse = new apigateway.CfnIntegrationResponse(this, "game-lambda-response", {
      apiId: api.ref,
      integrationId: gameAppIntegration.ref,
      integrationResponseKey: "$default",
    });

    const relayIntegration = new apigateway.CfnIntegration(this, "relay-lambda-integration", {
      apiId: api.ref,
      integrationType: "AWS_PROXY",
      integrationUri: "arn:aws:apigateway:" + config["region"] + ":lambda:path/2015-03-31/functions/" + relayFunc.functionArn + "/invocations",
      credentialsArn: role.roleArn,
    });

    const relayIntegrationResponse = new apigateway.CfnIntegrationResponse(this, "relay-lambda-response", {
      apiId: api.ref,
      integrationId: relayIntegration.ref,
      integrationResponseKey: "$default",
    });

    const connectRoute = new apigateway.CfnRoute(this, "connect-route", {
      apiId: api.ref,
      routeKey: "$connect",
      authorizationType: "NONE",
      target: "integrations/" + connectIntegration.ref,
    });

    const disconnectRoute = new apigateway.CfnRoute(this, "disconnect-route", {
      apiId: api.ref,
      routeKey: "$disconnect",
      authorizationType: "NONE",
      target: "integrations/" + disconnectIntegration.ref,
    });

    const getconnectionidRoute = new apigateway.CfnRoute(this, "getconnectid-route", {
      apiId: api.ref,
      routeKey: "getconnectionid",
      authorizationType: "NONE",
      target: "integrations/" + getconnectionidIntegration.ref,
    })

    const getconnectionidRouteResponse = new apigateway.CfnRouteResponse(this, "getconnecttionid-route-response", {
      apiId: api.ref,
      routeId: getconnectionidRoute.ref,
      routeResponseKey: "$default",
    });

    const gameAppRoute = new apigateway.CfnRoute(this, "game-app-route", {
      apiId: api.ref,
      routeKey: "game",
      authorizationType: "NONE",
      target: "integrations/" + gameAppIntegration.ref,
    });

    const gameAppRouteResponse = new apigateway.CfnRouteResponse(this, "game-app-route-response", {
      apiId: api.ref,
      routeId: gameAppRoute.ref,
      routeResponseKey: "$default",
    });

    const relayRoute = new apigateway.CfnRoute(this, "relay-route", {
      apiId: api.ref,
      routeKey: "sendToClient",
      authorizationType: "NONE",
      target: "integrations/" + relayIntegration.ref,
    })

    const relayRouteResponse = new apigateway.CfnRouteResponse(this, "relay-route-response", {
      apiId: api.ref,
      routeId: relayRoute.ref,
      routeResponseKey: "$default",
    });

    const deployment = new apigateway.CfnDeployment(this, `${name}-deployment`, {
      apiId: api.ref
    });

    new apigateway.CfnStage(this, `${name}-stage`, {
      apiId: api.ref,
      autoDeploy: true,
      deploymentId: deployment.ref,
      stageName: "dev",
      description: "deployment by cdk",
    })

    deployment.addDependency(connectRoute);
    deployment.addDependency(disconnectRoute);
    deployment.addDependency(gameAppRoute);
    deployment.addDependency(getconnectionidRoute);
    deployment.addDependency(relayRoute);

  }
}