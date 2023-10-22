import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as janken_service from '../lib/janken_service';

export class JankenAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new janken_service.JankenService(this, 'JankenGame');

  }
}
