/* =========================================================
   CHARCOAL MARKETPLACE
   REFUND + ADMIN CHAT MIGRATION
========================================================= */

USE railway;


/* =========================================================
   1. EXTEND ORDERS
========================================================= */

ALTER TABLE orders

ADD COLUMN IF NOT EXISTS refund_status
ENUM(
    'none',
    'pending',
    'processing',
    'completed',
    'failed',
    'cancelled'
)
NOT NULL DEFAULT 'none'
AFTER refund_reason;


/* ---------------------------------------------------------
   WHO REQUESTED / INITIATED THE REFUND
--------------------------------------------------------- */

ALTER TABLE orders

ADD COLUMN IF NOT EXISTS refund_requested_by
BIGINT UNSIGNED NULL
AFTER refund_status;


/* ---------------------------------------------------------
   WHEN REFUND WAS REQUESTED
--------------------------------------------------------- */

ALTER TABLE orders

ADD COLUMN IF NOT EXISTS refund_req-----d_at
DATETIME NULL
AFTER refund_requested_by;


/* ---------------------------------------------------------
   ADMIN WHO PROCESSED THE REFUND
--------------------------------------------------------- */

ALTER TABLE orders

ADD COLUMN IF NOT EXISTS refund_processed_by
BIGINT UNSIGNED NULL
AFTER refund_requested_at;


/* ---------------------------------------------------------
   WHEN REFUND WAS PROCESSED
--------------------------------------------------------- */

ALTER TABLE orders

ADD COLUMN IF NOT EXISTS refund_processed_at
DATETIME NULL
AFTER refund_processed_by;


/* ---------------------------------------------------------
   PI A2U REFUND PAYMENT ID
--------------------------------------------------------- */

ALTER TABLE orders

ADD COLUMN IF NOT EXISTS refund_payment_id
VARCHAR(255) NULL
AFTER refund_processed_at;


/* ---------------------------------------------------------
   PI BLOCKCHAIN TRANSACTION ID FOR REFUND
--------------------------------------------------------- */

ALTER TABLE orders

ADD COLUMN IF NOT EXISTS refund_txid
VARCHAR(255) NULL
AFTER refund_payment_id;


/* ---------------------------------------------------------
   REFUND FAILURE MESSAGE
--------------------------------------------------------- */

ALTER TABLE orders

ADD COLUMN IF NOT EXISTS refund_error
TEXT NULL
AFTER refund_txid;


/* ---------------------------------------------------------
   CANCELLATION INITIATED BY
--------------------------------------------------------- */

ALTER TABLE orders

ADD COLUMN IF NOT EXISTS cancelled_by
ENUM(
    'buyer',
    'vendor',
    'admin',
    'system'
)
NULL
AFTER cancellation_reason;


/* ---------------------------------------------------------
   CANCELLATION REVIEW TIME
--------------------------------------------------------- */

ALTER TABLE orders

ADD COLUMN IF NOT EXISTS cancellation_requested_at
DATETIME NULL
AFTER cancelled_by;


/* =========================================================
   2. INDEXES FOR REFUND MANAGEMENT
========================================================= */

ALTER TABLE orders

ADD INDEX idx_orders_refund_status
(refund_status);

ALTER TABLE orders

ADD INDEX idx_orders_refund_payment
(refund_payment_id);

ALTER TABLE orders

ADD INDEX idx_orders_refund_requested_by
(refund_requested_by);

ALTER TABLE orders

ADD INDEX idx_orders_refund_processed_by
(refund_processed_by);


/* =========================================================
   3. REFUND FOREIGN KEYS
========================================================= */

ALTER TABLE orders

ADD CONSTRAINT fk_orders_refund_requested_by

FOREIGN KEY (refund_requested_by)

REFERENCES users(id)

ON DELETE SET NULL

ON UPDATE CASCADE;


ALTER TABLE orders

ADD CONSTRAINT fk_orders_refund_processed_by

FOREIGN KEY (refund_processed_by)

REFERENCES users(id)

ON DELETE SET NULL

ON UPDATE CASCADE;


/* =========================================================
   4. SUPPORT CONVERSATIONS
========================================================= */

CREATE TABLE IF NOT EXISTS support_conversations (

    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,


    /* =====================================================
       PRIMARY PARTICIPANT
    ===================================================== */

    user_id BIGINT UNSIGNED NOT NULL,


    /* =====================================================
       OPTIONAL ORDER
    ===================================================== */

    order_id BIGINT UNSIGNED NULL,


    /* =====================================================
       USER TYPE
    ===================================================== */

    user_type ENUM(
        'buyer',
        'vendor'
    ) NOT NULL,


    /* =====================================================
       SUBJECT
    ===================================================== */

    subject VARCHAR(255) NOT NULL,


    /* =====================================================
       CONVERSATION STATUS
    ===================================================== */

    status ENUM(
        'open',
        'pending',
        'resolved',
        'closed'
    ) NOT NULL DEFAULT 'open',


    /* =====================================================
       PRIORITY
    ===================================================== */

    priority ENUM(
        'low',
        'normal',
        'high',
        'urgent'
    ) NOT NULL DEFAULT 'normal',


    /* =====================================================
       LAST MESSAGE INFORMATION
    ===================================================== */

    last_message_at DATETIME NULL,


    last_message_by BIGINT UNSIGNED NULL,


    /* =====================================================
       ADMIN ASSIGNMENT

       NULL = any Admin can handle it.
    ===================================================== */

    assigned_admin_id BIGINT UNSIGNED NULL,


    /* =====================================================
       TIMESTAMPS
    ===================================================== */

    created_at TIMESTAMP NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP NOT NULL
        DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,


    PRIMARY KEY (id),


    /* =====================================================
       INDEXES
    ===================================================== */

    INDEX idx_support_conversations_user
    (user_id),

    INDEX idx_support_conversations_order
    (order_id),

    INDEX idx_support_conversations_status
    (status),

    INDEX idx_support_conversations_priority
    (priority),

    INDEX idx_support_conversations_last_message
    (last_message_at),

    INDEX idx_support_conversations_admin
    (assigned_admin_id),


    /* =====================================================
       USER
    ===================================================== */

    CONSTRAINT fk_support_conversations_user

    FOREIGN KEY (user_id)

    REFERENCES users(id)

    ON DELETE CASCADE

    ON UPDATE CASCADE,


    /* =====================================================
       ORDER
    ===================================================== */

    CONSTRAINT fk_support_conversations_order

    FOREIGN KEY (order_id)

    REFERENCES orders(id)

    ON DELETE SET NULL

    ON UPDATE CASCADE,


    /* =====================================================
       LAST MESSAGE USER
    ===================================================== */

    CONSTRAINT fk_support_conversations_last_message

    FOREIGN KEY (last_message_by)

    REFERENCES users(id)

    ON DELETE SET NULL

    ON UPDATE CASCADE,


    /* =====================================================
       ASSIGNED ADMIN
    ===================================================== */

    CONSTRAINT fk_support_conversations_admin

    FOREIGN KEY (assigned_admin_id)

    REFERENCES users(id)

    ON DELETE SET NULL

    ON UPDATE CASCADE

) ENGINE=InnoDB

DEFAULT CHARSET=utf8mb4

COLLATE=utf8mb4_unicode_ci;


/* =========================================================
   5. SUPPORT MESSAGES
========================================================= */

CREATE TABLE IF NOT EXISTS support_messages (

    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,


    /* =====================================================
       CONVERSATION
    ===================================================== */

    conversation_id BIGINT UNSIGNED NOT NULL,


    /* =====================================================
       SENDER
    ===================================================== */

    sender_id BIGINT UNSIGNED NOT NULL,


    /* =====================================================
       SENDER TYPE
    ===================================================== */

    sender_type ENUM(
        'buyer',
        'vendor',
        'admin'
    ) NOT NULL,


    /* =====================================================
       MESSAGE
    ===================================================== */

    message TEXT NOT NULL,


    /* =====================================================
       OPTIONAL ATTACHMENT
    ===================================================== */

    attachment_url VARCHAR(1000) NULL,


    /* =====================================================
       READ STATUS
    ===================================================== */

    is_read BOOLEAN NOT NULL DEFAULT FALSE,


    /* =====================================================
       READ TIME
    ===================================================== */

    read_at DATETIME NULL,


    /* =====================================================
       TIMESTAMP
    ===================================================== */

    created_at TIMESTAMP NOT NULL
        DEFAULT CURRENT_TIMESTAMP,


    PRIMARY KEY (id),


    /* =====================================================
       INDEXES
    ===================================================== */

    INDEX idx_support_messages_conversation
    (conversation_id),

    INDEX idx_support_messages_sender
    (sender_id),

    INDEX idx_support_messages_created
    (created_at),

    INDEX idx_support_messages_read
    (is_read),


    /* =====================================================
       CONVERSATION
    ===================================================== */

    CONSTRAINT fk_support_messages_conversation

    FOREIGN KEY (conversation_id)

    REFERENCES support_conversations(id)

    ON DELETE CASCADE

    ON UPDATE CASCADE,


    /* =====================================================
       SENDER
    ===================================================== */

    CONSTRAINT fk_support_messages_sender

    FOREIGN KEY (sender_id)

    REFERENCES users(id)

    ON DELETE CASCADE

    ON UPDATE CASCADE

) ENGINE=InnoDB

DEFAULT CHARSET=utf8mb4

COLLATE=utf8mb4_unicode_ci;


/* =========================================================
   6. OPTIONAL: REFUND AUDIT LOG
========================================================= */

CREATE TABLE IF NOT EXISTS refund_logs (

    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,


    /* =====================================================
       ORDER
    ===================================================== */

    order_id BIGINT UNSIGNED NOT NULL,


    /* =====================================================
       ACTOR

       User/Admin who caused the event.
    ===================================================== */

    user_id BIGINT UNSIGNED NULL,


    /* =====================================================
       EVENT
    ===================================================== */

    event_type ENUM(
        'refund_requested',
        'vendor_cancelled',
        'refund_processing',
        'refund_completed',
        'refund_failed',
        'refund_cancelled'
    ) NOT NULL,


    /* =====================================================
       AMOUNT
    ===================================================== */

    amount_pi DECIMAL(20,8) NULL,


    /* =====================================================
       PI PAYMENT INFORMATION
    ===================================================== */

    pi_payment_id VARCHAR(255) NULL,

    txid VARCHAR(255) NULL,


    /* =====================================================
       DETAILS
    ===================================================== */

    reason VARCHAR(500) NULL,

    error_message TEXT NULL,


    /* =====================================================
       EXTRA DATA
    ===================================================== */

    metadata JSON NULL,


    /* =====================================================
       TIMESTAMP
    ===================================================== */

    created_at TIMESTAMP NOT NULL
        DEFAULT CURRENT_TIMESTAMP,


    PRIMARY KEY (id),


    /* =====================================================
       INDEXES
    ===================================================== */

    INDEX idx_refund_logs_order
    (order_id),

    INDEX idx_refund_logs_user
    (user_id),

    INDEX idx_refund_logs_event
    (event_type),

    INDEX idx_refund_logs_created
    (created_at),


    /* =====================================================
       ORDER
    ===================================================== */

    CONSTRAINT fk_refund_logs_order

    FOREIGN KEY (order_id)

    REFERENCES orders(id)

    ON DELETE CASCADE

    ON UPDATE CASCADE,


    /* =====================================================
       USER
    ===================================================== */

    CONSTRAINT fk_refund_logs_user

    FOREIGN KEY (user_id)

    REFERENCES users(id)

    ON DELETE SET NULL

    ON UPDATE CASCADE

) ENGINE=InnoDB

DEFAULT CHARSET=utf8mb4

COLLATE=utf8mb4_unicode_ci;


/* =========================================================
   7. COMPLETION MESSAGE
========================================================= */

SELECT
    'Refund + Chat database migration completed successfully'
    AS migration_status;
