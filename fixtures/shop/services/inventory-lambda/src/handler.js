const AWS = require('aws-sdk');
const db = new AWS.DynamoDB.DocumentClient();
const events = new AWS.EventBridge();

module.exports.reserve = async (event) => {
  for (const record of event.Records) {
    const msg = JSON.parse(record.body);
    await db.update({ TableName: process.env.STOCK_TABLE, Key: { sku: msg.sku }, UpdateExpression: 'SET reserved = reserved + :q' }).promise();
    await events.putEvents({ Entries: [{ EventBusName: 'shop-bus', Source: 'inventory', DetailType: 'StockReserved', Detail: JSON.stringify({ sku: msg.sku }) }] }).promise();
  }
};

module.exports.getStock = async (event) => {
  const res = await db.get({ TableName: process.env.STOCK_TABLE, Key: { sku: event.pathParameters.sku } }).promise();
  return { statusCode: 200, body: JSON.stringify({ sku: event.pathParameters.sku, available: 0, reserved: 0 }) };
};

module.exports.onOrderEvent = async (event) => {
  const sqs = new AWS.SQS();
  await sqs.sendMessage({ QueueUrl: 'https://sqs.us-east-1.amazonaws.com/000000000000/inventory-reservations', MessageBody: event.Records[0].Sns.Message }).promise();
};
