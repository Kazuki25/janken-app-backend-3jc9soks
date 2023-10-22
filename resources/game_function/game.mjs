import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import * as crypto from "crypto";

const clientDB = new DynamoDBClient({});
const clientSQS = new SQSClient({});

export const handler = async (event) => {
  const tableName = process.env['TABLE_NAME'];
  const QueueUrl = process.env['QUEUE_URL'];

  const connectionId = event.requestContext.connectionId;
  const body = JSON.parse(event.body);
  const username = body.name;
  const endpointUrl = 'https://' + event.requestContext.domainName + '/' + event.requestContext.stage;
  let response = {
    statusCode: 200,
    body: JSON.stringify({ message: "OK" })
  };

  let gameId = "";

  if (!body.gameId) {
    // entry process
    // receive message
    let response_rcv;
    try {
      response_rcv = await getMessageFromQueue(QueueUrl);
    } catch (error) {
      console.log(error);
      return createErrorResponse(error, "Failed to get messages from queue");
    }

    if (response_rcv.Messages == undefined) {
      // send message to sqs to entry.
      try {
        await sendEntryToQueue(QueueUrl, connectionId, username);
      } catch (error) {
        console.log(error);
        return createErrorResponse(error, "Failed to send messages to queue");
      }

      // send message to the client.
      try {
        const data = {
          gameId: "",
          action: "entry_done",
          nextState: "waiting",
          limitTime: 60000, // milliseconds
          message: "エントリーが完了しました。対戦相手が来るのを待っています。",
        };
        await sendMessageToClient(endpointUrl, data, connectionId);
      } catch (error) {
        console.log(error);
        return createErrorResponse(error, "Failed to send massages to client");
      }

      console.info("new entry done.");
      return response;

    } else {
      // Messages exist in the queue.
      const msg = response_rcv.Messages[0];
      if (msg.MessageAttributes.ConnectionId.StringValue === connectionId) {
        // send message to the client.
        try {
          const data = {
            gameId: "",
            action: "entry_done",
            nextState: "waiting",
            limitTime: 60000, // milliseconds
            message: "すでにエントリー済みです。対戦相手が見つかるまでお待ちください。",
          };
          await sendMessageToClient(endpointUrl, data, connectionId);
        } catch (error) {
          console.log(error);
          return createErrorResponse(error, "Failed to send massages to client");
        }

        console.info("keep waiting.");
        return response;
      } else {
        const users = [
          { connectionId: connectionId, username: username },
          { connectionId: msg.MessageAttributes.ConnectionId.StringValue, username: msg.MessageAttributes.UserName.StringValue },
        ]
        // The received message issued by others then matching.
        let maxTurns
        try {
          const response = await putGameSessionItemToDB(tableName, users);
          gameId = response["gameId"];
          maxTurns = response["maxTurns"];
        } catch (error) {
          return createErrorResponse(error, "Failed to put item to DB")
        }

        try {
          const data = {
            gameId: gameId,
            action: "matched", // ユーザとマッチしたことを通知する。
            nextState: "game_start",
            limitTime: 5000, // milliseconds
            maxTurns: maxTurns,
            message: `対戦相手が見つかりました。ゲームを開始します。ゲームは${maxTurns}回勝負です。`,
            // users: users.map((x) => x.username),
            users: users,
          };
          for (const user of users) {
            await sendMessageToClient(endpointUrl, data, user.connectionId);
          }
        } catch (error) {
          console.log(error);
          return createErrorResponse(error, "Failed to send messages to client");
        }

        try {
          await updateGameStatus(tableName, gameId, "ongoing");
        } catch (error) {
          console.log(error);
          return createErrorResponse("Failed to update game status on DB: " + gameId);
        }

        try {
          await deleteMessageFromQueue(QueueUrl, msg.ReceiptHandle);
        } catch (error) {
          console.log(error);
          return createErrorResponse(error, "Failed to delete messages from queue");
        }

        const data = {
          gameId: gameId,
          action: "select_hand",
          nextState: "select_hand",
          limitTime: 5000, // milliseconds
          message: "第1戦目の勝負で出す手を[rock/scissors/paper]の中から選んでください。",
          users: users,
          currentTurn: 1,
          maxTurns: maxTurns,
        };
        try {
          for (const user of users) {
            await sendMessageToClient(endpointUrl, data, user.connectionId);
          }
        } catch (error) {
          console.log(error);
          return createErrorResponse("Failed to send messages to client");
        }

        console.info("done");
        return response;
      }
    }
  } else {
    // game process
    gameId = body.gameId;
    const myhand = body.hand;
    console.log(`gameid is ${gameId}`);
    let gameSession;
    let opponent;
    try {
      const responseItem = await getGameSessionByGameId(tableName, gameId);
      if (responseItem["Item"] === undefined) {
        response["body"] = JSON.stringify({ 
          gameId: gameId,
          action: "session_not_found",
          nextState: "entry",
          limitTime: 5000, // milliseconds
          message: "指定されたセッションは存在しません。 gameId: " + gameId
        });
        return response;
      }
      gameSession = responseItem["Item"];
    } catch (error) {
      console.log(error);
      return createErrorResponse(error, "Failed to get game session from DB: " + gameId);
    }
    const currentTurn = Number(gameSession["CurrentTurn"]["N"]);
    const maxTurn = Number(gameSession["MaxTurns"]["N"]);
    let opponentIndex = 1; //initial value assuming User1 is opponent.
    if (gameSession["User2"]["M"]["name"]["S"] != username) {
      opponentIndex = 2;
    } else {
    }
    opponent = {
      username: gameSession["User" + opponentIndex]["M"]["name"]["S"],
      connectionId: gameSession["User" + opponentIndex]["M"]["connectionId"]["S"]
    };
    const users = [username, opponent.username];
    const connectionIdList = [connectionId, opponent.connectionId];

    // check game state.
    // "finished" => send message and finish.
    // other => continue
    if (gameSession["GameStatus"]["S"] === "Finished") {
      response["body"] = JSON.stringify({
        gameId: gameId,
        action: "session_not_found",
        nextState: "entry",
        limitTime: 5000, // milliseconds
        message: "このゲームはすでに終了しています。 gameId:" + gameId
      });
      return response;
    }

    if (myhand != "rock" && myhand != "scissors" && myhand != "paper") {
      response["body"] = JSON.stringify({
        gameId: gameId,
        action: "invalid_hand",
        nextState: "select_hand",
        limitTime: -1, // milliseconds
        currentTurn: currentTurn,
        maxTurns: maxTurn,
        message: "あなたの出した手が正しくありません。[rock/scissors/paper]のいずれかを選んでください。"
      });
      return response;
    }

    const currentSession = gameSession["Transactions"]["M"][`turn_${currentTurn}`]["M"];

    if (!currentSession[username] && !currentSession[opponent["username"]]) {
      // In case that no hand is registered.
      // Action: Register my hand and wait.
      let value = { ...currentSession };
      value[username] = {
        M: {
          hand: { S: myhand }
        }
      };
      try {
        await updateGameTransaction(tableName, gameId, value, currentTurn);
      } catch (error) {
        console.log(error);
        return createErrorResponse(error, "Failed to register your hand:" + gameId);
      }
      response["body"] = JSON.stringify({
        gameId: gameId,
        action: "register_hand",
        nextState: "waiting_opponent",
        limitTime: 5000, // milliseconds
        currentTurn: currentTurn,
        maxTurns: maxTurn,
        message: "あなたの手を記録しました。相手が手を出すまでお待ちください。"
      });
      return response;
    }

    if (currentSession[username] && !currentSession[opponent["username"]]) {
      // In case that my hand is registered and opponent's hand is notregistered.
      // Action: keep waiting
      response["body"] = JSON.stringify({
        gameId: gameId,
        action: "already_registered",
        nextState: "waiting_opponent",
        limitTime: 5000, // milliseconds
        message: "あなたの手は記録されています。相手が手を出すまでお待ちください。"
      });
      return response;
    }

    if (!currentSession[username] && currentSession[opponent["username"]]) {
      // In case that my hand is not registered and opponent's hand is registered.
      // Action: check winner
      const opponentHand = currentSession[opponent["username"]]["M"]["hand"]["S"];
      let winner = username;
      if (myhand === opponentHand) {
        winner = "even";
      };
      if (myhand === "rock" && opponentHand === "paper") {
        winner = opponent.username;
      };
      if (myhand === "paper" && opponentHand === "scissors") {
        winner = opponent.username;
      };
      if (myhand === "scissors" && opponentHand === "rock") {
        winner = opponent.username;
      };
      let value = { ...currentSession };
      value[username] = {
        M: {
          hand: { S: myhand }
        }
      };
      value["result"] = {
        M: {
          winner: { S: winner }
        }
      };
      value["status"] = {
        S: "Finished"
      }

      try {
        await updateGameTransaction(tableName, gameId, value, currentTurn);
      } catch (error) {
        console.log(error);
        return createErrorResponse("Failed to update game Transactions: " + gameId);
      }

      const msg = winner === "even" ? "引き分けです。" : `${winner}の勝ちです。`;
      const result = {
        gameId: gameId,
        action: "result",
        nextState: "show_result",
        currentTurn: currentTurn,
        maxTurns: maxTurn,
        limitTime: 5000, // milliseconds
        winner: winner,
        message: `第${currentTurn}戦の勝負は、${msg}¥nあなたが出した手は「${myhand}」、相手が出した手は「${opponentHand}」でした。`,
        users: users,
      };
      try {
        for (const user of connectionIdList) {
          await sendMessageToClient(endpointUrl, result, user);
        }
      } catch (error) {
        console.log(error);
        return createErrorResponse(error, "Failed to send messages to client: " + gameId);
      }

      // 次の対戦に進むかどうか確認する。
      if (currentTurn < maxTurn) {
        const nextTurn = currentTurn + 1;
        try {
          await updateGameToNextTurn(tableName, gameId, currentTurn);
        } catch (error) {
          console.log(error);
          return createErrorResponse(error, "Failed to update current turn: " + gameId);
        }

        const data = {
          gameId: gameId,
          currentTurn: nextTurn,
          maxTurns: maxTurn,
          action: "select_hand",
          nextState: "select_hand",
          limitTime: 5000, // milliseconds
          message: `次の対戦に移ります(${nextTurn}/${maxTurn})。第${nextTurn}戦目の勝負で出す手を[rock/scissors/paper]の中から選んでください。`,
          users: users,
        };
        try {
          for (const user of connectionIdList) {
            await sendMessageToClient(endpointUrl, data, user);
          }
        } catch (error) {
          console.log(error);
          return createErrorResponse(error, "Failed to send messages to client: " + gameId);
        }
        return response
      }

      if (currentTurn >= maxTurn) {
        try {
          await updateGameStatus(tableName, gameId, "Finished");
        } catch (error) {
          console.log(error);
          return createErrorResponse(error, "Failed to update game status: " + gameId);
        }
        const data = {
          action: "game_finished",
          nextState: "game_finished",
          limitTime: 10000, // milliseconds
          message: `すべての対戦が終了しました。`,
          users: users,
        };
        try {
          for (const user of connectionIdList) {
            await sendMessageToClient(endpointUrl, data, user);
          }
        } catch (error) {
          console.log(error);
          return createErrorResponse(error, "Failed to send messages to client: " + gameId);
        }
        return response
      }
      return response;
    }
    
    return response;
  }

};


/******************************************
 *                                        *
 * sub function's definitions             *
 *                                        *
 ******************************************/

const createErrorResponse = (error, msg) => {
  return {
    statusCode: 500,
    body: {
      message: msg,
      error: error,
    }
  }
}

const getMessageFromQueue = async (queueUrl) => {
  // receive message
  // const client = new SQSClient({});
  const input = { // ReceiveMessageRequest
    QueueUrl: queueUrl,
    AttributeNames: [
      "All",
    ],
    MessageAttributeNames: [
      "Action", "ConnectionId", "Version", "UserName"
    ],
    MaxNumberOfMessages: Number("1"),
    WaitTimeSeconds: Number("1"),
  };
  const command = new ReceiveMessageCommand(input);
  return await clientSQS.send(command);
};

const sendEntryToQueue = async (queueUrl, connectionId, username) => {
  // const client = new SQSClient({});
  const input = { // SendMessageRequest
    QueueUrl: queueUrl,
    MessageBody: "entry", // required
    MessageAttributes: {
      "Action": {
        DataType: "String",
        StringValue: "Entry"
      },
      "ConnectionId": {
        DataType: "String",
        StringValue: connectionId
      },
      "UserName": {
        DataType: "String",
        StringValue: username
      },
      "Version": {
        DataType: "String",
        StringValue: "0.0.1"
      }
    },

  };
  const command = new SendMessageCommand(input);
  return await clientSQS.send(command);
};

const deleteMessageFromQueue = async (queueUrl, receiptHandle) => {
  // const client = new SQSClient({});
  const input = {
    QueueUrl: queueUrl,
    ReceiptHandle: receiptHandle,
  };
  const command = new DeleteMessageCommand(input);
  await clientSQS.send(command);
};

const getGameSessionByGameId = async (tableName, gameId) => {
  const input = {
    Key: {
      gameId: {
        S: gameId
      }
    },
    // AttributesToGet: [ // AttributeNameList
    //   "Transactions",
    // ],
    "TableName": tableName,
  }
  const command = new GetItemCommand(input);
  return await clientDB.send(command);
}

const putGameSessionItemToDB = async (tableName, users) => {
  // create game session
  // const client = new DynamoDBClient({});
  const gameId = "janken-" + crypto.randomUUID();
  const maxTurns = "5";
  let trans = {};
  for (let t = 1; t <= maxTurns; t++) {
    trans[`turn_${t}`] = {
      M: {
        status: {
          S: t == 1 ? "ongoing" : "not started"
        }
      }
    }
  }
  const input = {
    Item: {
      gameId: {
        S: gameId
      },
      User1: {
        M: {
          connectionId: {
            S: users[0].connectionId
          },
          name: {
            S: users[0].username
          }
        }
      },
      User2: {
        M: {
          connectionId: {
            S: users[1].connectionId
          },
          name: {
            S: users[1].username
          }
        }
      },
      GameSetting: {
        S: "Standard janken"
      },
      GameStatus: {
        S: "not start"
      },
      Transactions: {
        M: trans,
      },
      MaxTurns: {
        N: maxTurns
      },
      CurrentTurn: {
        N: "1"
      },
    },
    TableName: tableName
  };
  const command = new PutItemCommand(input);
  await clientDB.send(command);
  return { gameId: gameId, maxTurns: maxTurns };
};

const updateGameStatus = async (tableName, gameId, status) => {
  // const client = new DynamoDBClient({});
  const input = {
    TableName: tableName,
    Key: {
      gameId: {
        S: gameId
      }
    },
    UpdateExpression: "set GameStatus = :status",
    ExpressionAttributeValues: {
      ":status": {
        S: status,
      },
    },
    ReturnValues: "NONE",
  };
  const command = new UpdateItemCommand(input);
  return await clientDB.send(command);
};

const updateGameTransaction = async (tableName, gameId, value, currentTurn) => {
  console.log(value);
  const input = {
    TableName: tableName,
    Key: {
      gameId: {
        S: gameId
      }
    },
    ExpressionAttributeNames: {
      "#T": "Transactions",
      "#t": `turn_${currentTurn}`
    },
    UpdateExpression: `set #T.#t = :trans`,
    ExpressionAttributeValues: {
      ":trans": { M: value },
    },
    ReturnValues: "NONE",
  }
  const command = new UpdateItemCommand(input);
  return await clientDB.send(command);
}

const updateGameToNextTurn = async (tableName, gameId, currentTurn) => {
  const input = {
    TableName: tableName,
    Key: {
      gameId: {
        S: gameId
      }
    },
    ExpressionAttributeNames: {
      "#C": "CurrentTurn",
      "#T": "Transactions",
      "#t": `turn_${currentTurn}`,
      "#tn": `turn_${Number(currentTurn) + 1}`,
      "#s": "status",
    },
    UpdateExpression: "SET #T.#t.#s = :status1, #T.#tn.#s = :status2 ADD #C :val",
    ExpressionAttributeValues: {
      ":val": { N: "1" },
      ":status1": { S: "finished" },
      ":status2": { S: "ongoing" }
    },
    ReturnValues: "NONE",
  }
  const command = new UpdateItemCommand(input);
  return await clientDB.send(command);
}

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
