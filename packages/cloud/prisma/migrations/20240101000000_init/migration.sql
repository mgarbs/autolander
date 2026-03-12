-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MANAGER', 'AGENT');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('ACTIVE', 'SOLD', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ConversationState" AS ENUM ('NEW', 'ENGAGED', 'NEGOTIATING', 'APPOINTMENT_SET', 'CLOSED_WON', 'CLOSED_LOST', 'STALE');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "AgentConnectionStatus" AS ENUM ('ONLINE', 'OFFLINE', 'BUSY');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('SOLO', 'PRO', 'TEAM', 'DEALER');

-- CreateEnum
CREATE TYPE "FeedType" AS ENUM ('CARGURUS', 'CARSCOM', 'AUTOTRADER', 'GENERIC_XML', 'HTML_SCRAPE');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "plan" "PlanTier" NOT NULL DEFAULT 'SOLO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'AGENT',
    "passwordHash" TEXT NOT NULL,
    "salespersonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "vin" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "trim" TEXT,
    "price" DOUBLE PRECISION,
    "mileage" INTEGER,
    "color" TEXT,
    "bodyStyle" TEXT,
    "transmission" TEXT,
    "fuelType" TEXT,
    "condition" TEXT,
    "description" TEXT,
    "photos" TEXT[],
    "status" "VehicleStatus" NOT NULL DEFAULT 'ACTIVE',
    "fbPosted" BOOLEAN NOT NULL DEFAULT false,
    "fbPostDate" TIMESTAMP(3),
    "generatedTitle" TEXT,
    "generatedDescription" TEXT,
    "dealerUrl" TEXT,
    "feedId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "threadId" TEXT,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT,
    "vehicleId" TEXT,
    "buyerName" TEXT NOT NULL,
    "buyerId" TEXT,
    "buyerEmail" TEXT,
    "buyerPhone" TEXT,
    "state" "ConversationState" NOT NULL DEFAULT 'NEW',
    "leadScore" INTEGER NOT NULL DEFAULT 20,
    "sentimentScore" DOUBLE PRECISION,
    "lastMessageAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "text" TEXT NOT NULL,
    "intent" TEXT,
    "metadata" JSONB,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT,
    "vehicleId" TEXT,
    "buyerName" TEXT NOT NULL,
    "scheduledTime" TIMESTAMP(3) NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "notes" TEXT,
    "googleEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerConfig" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "platform" TEXT,
    "scrapeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "schedule" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealerConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchedulerState" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "lastPostRun" TIMESTAMP(3),
    "postsToday" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchedulerState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AgentConnectionStatus" NOT NULL DEFAULT 'OFFLINE',
    "fbSessionValid" BOOLEAN NOT NULL DEFAULT false,
    "fbSessionExpiry" TIMESTAMP(3),
    "lastHeartbeat" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "AgentConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceHistory" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "previousPrice" DOUBLE PRECISION,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryFeed" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "feedUrl" TEXT NOT NULL,
    "feedType" "FeedType" NOT NULL,
    "name" TEXT,
    "syncScheduleCron" TEXT NOT NULL DEFAULT '0 */6 * * *',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "vehicleCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryFeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedSyncLog" (
    "id" TEXT NOT NULL,
    "feedId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "vehiclesFound" INTEGER NOT NULL DEFAULT 0,
    "vehiclesAdded" INTEGER NOT NULL DEFAULT 0,
    "vehiclesUpdated" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "FeedSyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgSettings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "googleCredentials" JSONB,
    "googleToken" JSONB,
    "googleCalendarId" TEXT,
    "gmailAddress" TEXT,
    "gmailAppPassword" TEXT,
    "twilioAccountSid" TEXT,
    "twilioAuthToken" TEXT,
    "twilioFromNumber" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "operatingHours" JSONB,

    CONSTRAINT "OrgSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "User_orgId_idx" ON "User"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "User_orgId_username_key" ON "User"("orgId", "username");

-- CreateIndex
CREATE INDEX "Vehicle_orgId_idx" ON "Vehicle"("orgId");

-- CreateIndex
CREATE INDEX "Vehicle_orgId_status_idx" ON "Vehicle"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_orgId_vin_key" ON "Vehicle"("orgId", "vin");

-- CreateIndex
CREATE INDEX "Conversation_orgId_idx" ON "Conversation"("orgId");

-- CreateIndex
CREATE INDEX "Conversation_orgId_state_idx" ON "Conversation"("orgId", "state");

-- CreateIndex
CREATE INDEX "Conversation_orgId_leadScore_idx" ON "Conversation"("orgId", "leadScore");

-- CreateIndex
CREATE INDEX "Conversation_orgId_threadId_idx" ON "Conversation"("orgId", "threadId");

-- CreateIndex
CREATE INDEX "Message_conversationId_idx" ON "Message"("conversationId");

-- CreateIndex
CREATE INDEX "Message_status_idx" ON "Message"("status");

-- CreateIndex
CREATE INDEX "Appointment_orgId_idx" ON "Appointment"("orgId");

-- CreateIndex
CREATE INDEX "Appointment_orgId_scheduledTime_idx" ON "Appointment"("orgId", "scheduledTime");

-- CreateIndex
CREATE INDEX "DealerConfig_orgId_idx" ON "DealerConfig"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "SchedulerState_orgId_key" ON "SchedulerState"("orgId");

-- CreateIndex
CREATE INDEX "SchedulerState_orgId_idx" ON "SchedulerState"("orgId");

-- CreateIndex
CREATE INDEX "AgentConnection_orgId_idx" ON "AgentConnection"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentConnection_orgId_userId_key" ON "AgentConnection"("orgId", "userId");

-- CreateIndex
CREATE INDEX "ActivityLog_orgId_idx" ON "ActivityLog"("orgId");

-- CreateIndex
CREATE INDEX "ActivityLog_orgId_createdAt_idx" ON "ActivityLog"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE INDEX "PriceHistory_vehicleId_idx" ON "PriceHistory"("vehicleId");

-- CreateIndex
CREATE INDEX "InventoryFeed_orgId_idx" ON "InventoryFeed"("orgId");

-- CreateIndex
CREATE INDEX "FeedSyncLog_feedId_idx" ON "FeedSyncLog"("feedId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgSettings_orgId_key" ON "OrgSettings"("orgId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "InventoryFeed"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerConfig" ADD CONSTRAINT "DealerConfig_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchedulerState" ADD CONSTRAINT "SchedulerState_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentConnection" ADD CONSTRAINT "AgentConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentConnection" ADD CONSTRAINT "AgentConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceHistory" ADD CONSTRAINT "PriceHistory_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryFeed" ADD CONSTRAINT "InventoryFeed_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedSyncLog" ADD CONSTRAINT "FeedSyncLog_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "InventoryFeed"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgSettings" ADD CONSTRAINT "OrgSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

