-- CreateTable
CREATE TABLE "Block" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "version" TEXT,
    "pageNumber" INTEGER,
    "modelProvider" TEXT,
    "modelName" TEXT,
    "generatedAt" DATETIME,
    "inputSourceBlockIds" TEXT,
    "citations" TEXT,
    "coveragePermille" INTEGER,
    "contentHash" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Publication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "summaryBlockId" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "coveragePermille" INTEGER NOT NULL,
    "snapshot" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "GatewayState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX "Block_idempotencyKey_key" ON "Block"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Block_createdAt_id_idx" ON "Block"("createdAt", "id");

-- CreateIndex
CREATE INDEX "Block_kind_createdAt_id_idx" ON "Block"("kind", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Publication_idempotencyKey_key" ON "Publication"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Publication_createdAt_id_idx" ON "Publication"("createdAt", "id");
