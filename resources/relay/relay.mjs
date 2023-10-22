import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

export const handler = async (event) => {
  console.log(event);
  const data = JSON.parse(event.body);
  const receiver = data.connectionid;
  const endpoint = 'https://' + event.requestContext.domainName + '/' + event.requestContext.stage;
  
  const payload = {
    message: "ping",
    sender: event.requestContext.connectionId
  }
  
  await sendMessageToClient(endpoint, payload, receiver);
  
  const response = {
    statusCode: 200,
    body: JSON.stringify('Sucess send!'),
  };
  return response;
};

const sendMessageToClient = async (endpoint, data, receiver) => {
  const client = new ApiGatewayManagementApiClient({
    endpoint: endpoint
  });
  const input = { // PostToConnectionRequest
    Data: JSON.stringify(data),
    ConnectionId: receiver,
  };
  const command = new PostToConnectionCommand(input);
  await client.send(command);
};
