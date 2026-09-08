/* =========================================================
   CHARCOAL MARKETPLACE
   REFUND + SUPPORT CHAT UPDATE 002
========================================================= */

USE railway;

ALTER TABLE orders
  ADD INDEX idx_orders_refund_case
  (refund_status, cancelled_at, refund_requested_at);

ALTER TABLE support_conversations
  ADD INDEX idx_support_conversations_status_last
  (status, last_message_at);

ALTER TABLE support_messages
  ADD INDEX idx_support_messages_conversation_created
  (conversation_id, created_at);

SELECT
  'Refund + Support Chat update 002 completed successfully'
  AS migration_status;
