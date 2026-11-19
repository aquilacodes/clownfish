const { Consumer } = require('sqs-consumer');
const fetch = require('node-fetch');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const ddb = DynamoDBDocumentClient.from(new (require('@aws-sdk/client-dynamodb').DynamoDBClient)({}));
const s3 = new S3Client({});
const lambda = new LambdaClient({});

async function sendEmail(job) {
  await fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST', body: JSON.stringify({ personalizations: [{ to: job.to }], template_id: job.template }) });
  await ddb.send(new PutCommand({ TableName: 'email-log', Item: { id: job.id, to: job.to, sentAt: Date.now() } }));
  await s3.send(new PutObjectCommand({ Bucket: 'email-archive', Key: `emails/${job.id}.json`, Body: JSON.stringify(job) }));
  await lambda.send(new InvokeCommand({ FunctionName: process.env.INVENTORY_FN, Payload: JSON.stringify({ orderId: job.orderId }) }));
}

const app = Consumer.create({
  queueUrl: process.env.EMAIL_QUEUE_URL,
  handleMessage: async (message) => {
    await sendEmail(JSON.parse(message.Body));
  },
});
app.start();
