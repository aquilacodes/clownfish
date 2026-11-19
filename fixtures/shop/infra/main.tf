resource "aws_sns_topic" "order_events" {
  name = "order-events"
}

resource "aws_sqs_queue" "email" {
  name = "email-jobs"
}

resource "aws_sns_topic_subscription" "orders_to_email" {
  topic_arn = aws_sns_topic.order_events.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.email.arn
}
