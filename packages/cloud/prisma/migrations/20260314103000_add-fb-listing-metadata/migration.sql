ALTER TABLE "Vehicle"
ADD COLUMN "fbListingUrl" TEXT,
ADD COLUMN "fbListingId" TEXT,
ADD COLUMN "fbPostedPrice" DOUBLE PRECISION,
ADD COLUMN "fbPostedPhotosHash" TEXT,
ADD COLUMN "fbPostedDescription" TEXT,
ADD COLUMN "fbStale" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "fbStaleReason" TEXT,
ADD COLUMN "fbStaleSince" TIMESTAMP(3);

CREATE INDEX "Vehicle_orgId_fbStale_idx" ON "Vehicle"("orgId", "fbStale");
