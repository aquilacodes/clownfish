import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sns = new SNSClient({});
const sqs = new SQSClient({});
const TOPIC = process.env.ORDER_EVENTS_TOPIC_ARN!;

export async function publishOrderCreated(order: { id: string; userId: string }) {
  await sns.send(new PublishCommand({ TopicArn: TOPIC, Message: JSON.stringify({ type: 'OrderCreated', orderId: order.id, userId: order.userId }) }));
}

export async function enqueueEmail(to: string, template: string) {
  await sqs.send(new SendMessageCommand({ QueueUrl: process.env.EMAIL_QUEUE_URL, MessageBody: JSON.stringify({ to, template }) }));
}
