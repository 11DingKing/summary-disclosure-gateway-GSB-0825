-- AlterTable: idempotency records reserve the key (PENDING) before the
-- request side effect runs, and only become COMPLETED once the response is
-- stored. The primary-key unique constraint on "key" makes reservation atomic.
ALTER TABLE "IdempotencyRecord" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PENDING';

-- Backfill: rows that already carry a stored response are completed reservations.
UPDATE "IdempotencyRecord" SET "status" = 'COMPLETED' WHERE "statusCode" <> 0;
