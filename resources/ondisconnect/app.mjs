import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb"; // ES Modules import

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const tableName = process.env["TABLE_NAME"];
  const client = new DynamoDBClient({});
  const input = {
    "Key": {
      "connectionId": {
        "S": connectionId
      }
    },
    "TableName": tableName
  };
  const command = new DeleteItemCommand(input);

  try {
    await client.send(command);
  } catch (error) {
    return {
        statusCode: 500,
        body: "Failed to disconnect: " + JSON.stringify(error),
    }
  }
  // TODO implement
  return { statusCode: 200, body: "Disconnected" };
};
