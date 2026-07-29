-- ---------------------------------------------------------------------------
-- MIGRATION 0002 — allow one inbound WhatsApp message to legitimately
-- produce MULTIPLE ledger entries.
--
-- Bug fixed here: idx_ledger_entries_whatsapp_message_id (from the
-- baseline migration) was a plain UNIQUE index on whatsapp_message_id
-- alone — built back when "one inbound message -> at most one ledger
-- entry" was always true, specifically to protect against WhatsApp
-- redelivering the same webhook and double-logging a transaction.
--
-- That assumption stopped holding once Kika gained the ability to
-- extract SEVERAL distinct transactions from one free-form message
-- (e.g. a merchant recapping a whole day of sales and expenses in one
-- text). When that happens, the second, third, ... entry for the same
-- message hits the unique constraint, throws, and crashes the whole
-- job — which then gets retried, and on retry the FIRST thing checked
-- is "does an entry for this message already exist?", finds the one
-- entry that succeeded before the crash, and bails out treating the
-- whole message as already handled. Net effect: only the first of N
-- transactions was ever recorded, silently, while Kika's own
-- confirmation text said all N would be.
--
-- Fix: give each entry within a multi-transaction message its own
-- sequence index (0 for an ordinary single-transaction message, 0..N-1
-- for a split message), and make the uniqueness constraint composite —
-- (whatsapp_message_id, message_sequence_index). This still fully
-- blocks a genuine duplicate delivery of the exact same message from
-- re-creating the exact same entry, while allowing the legitimate case
-- of several different entries, at different sequence indexes, from
-- one message.
-- ---------------------------------------------------------------------------

ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS message_sequence_index INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_ledger_entries_whatsapp_message_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_entries_whatsapp_message_id_seq
    ON ledger_entries (whatsapp_message_id, message_sequence_index) WHERE whatsapp_message_id IS NOT NULL;
