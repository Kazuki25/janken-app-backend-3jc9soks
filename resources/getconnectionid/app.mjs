export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  return { statusCode: 200, body: JSON.stringify({action: "getconnectionid", connectionId: connectionId}) };
};
