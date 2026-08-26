-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "docKey" TEXT,
    "version" TEXT,
    "pageStart" INTEGER,
    "pageEnd" INTEGER,
    "contentHash" TEXT,
    "sourceRevision" INTEGER NOT NULL DEFAULT 1,
    "modelProvider" TEXT,
    "modelName" TEXT,
    "generatedAt" DATETIME,
    "inputBlockIds" TEXT,
    "coveragePermille" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Citation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "submissionId" TEXT NOT NULL,
    "sourceBlockId" TEXT NOT NULL,
    "sourceContentHash" TEXT NOT NULL,
    "outputStart" INTEGER NOT NULL,
    "outputEnd" INTEGER NOT NULL,
    "sourceStart" INTEGER,
    "sourceEnd" INTEGER,
    "ordinal" INTEGER NOT NULL,
    CONSTRAINT "Citation_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Publication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "snapshot" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Submission_kind_createdAt_id_idx" ON "Submission"("kind", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Submission_docKey_createdAt_id_idx" ON "Submission"("docKey", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Submission_createdAt_id_idx" ON "Submission"("createdAt", "id");

-- CreateIndex
CREATE INDEX "Citation_submissionId_idx" ON "Citation"("submissionId");

-- CreateIndex
CREATE INDEX "Citation_sourceBlockId_idx" ON "Citation"("sourceBlockId");

-- CreateIndex
CREATE INDEX "Publication_scope_createdAt_id_idx" ON "Publication"("scope", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Publication_createdAt_id_idx" ON "Publication"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Publication_scope_revision_key" ON "Publication"("scope", "revision");
