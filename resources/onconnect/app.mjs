import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb"; // ES Modules import

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const tableName = process.env["TABLE_NAME"];
  const client = new DynamoDBClient({});
  const input = {
    "Item": {
      "connectionId": {
        "S": connectionId
      }
    },
    "TableName": tableName
  };
  const command = new PutItemCommand(input);

  try {
    await client.send(command);
  } catch (error) {
    return {
        statusCode: 500,
        body: "Failed to connect: " + JSON.stringify(error),
    }
  }

  return { statusCode: 200, body: "Connected." };
};
