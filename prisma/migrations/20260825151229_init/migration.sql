-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT,
    "version" TEXT,
    "page" TEXT,
    "modelProvider" TEXT,
    "modelName" TEXT,
    "generatedAt" DATETIME,
    "inputSourceBlockIds" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CitationSpan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "submissionId" TEXT NOT NULL,
    "sourceBlockId" TEXT NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "citedHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CitationSpan_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CitationSpan_sourceBlockId_fkey" FOREIGN KEY ("sourceBlockId") REFERENCES "Submission" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Publication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "submissionId" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "coveragePermille" INTEGER NOT NULL,
    "sourceHashesValid" BOOLEAN NOT NULL,
    "snapshot" TEXT NOT NULL,
    "publishedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Publication_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("key", "endpoint")
);

-- CreateIndex
CREATE INDEX "Submission_kind_createdAt_id_idx" ON "Submission"("kind", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Submission_createdAt_id_idx" ON "Submission"("createdAt", "id");

-- CreateIndex
CREATE INDEX "CitationSpan_submissionId_idx" ON "CitationSpan"("submissionId");

-- CreateIndex
CREATE INDEX "CitationSpan_sourceBlockId_idx" ON "CitationSpan"("sourceBlockId");

-- CreateIndex
CREATE UNIQUE INDEX "CitationSpan_submissionId_sourceBlockId_startOffset_endOffset_key" ON "CitationSpan"("submissionId", "sourceBlockId", "startOffset", "endOffset");

-- CreateIndex
CREATE INDEX "Publication_publishedAt_id_idx" ON "Publication"("publishedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Publication_submissionId_revision_key" ON "Publication"("submissionId", "revision");
