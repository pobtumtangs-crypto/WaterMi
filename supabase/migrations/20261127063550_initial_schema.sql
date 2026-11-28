-- Supabase Database Schema for WaterMI
-- Run this in the Supabase SQL Editor

-- Enable UUID extension (must be first)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Plants table
CREATE TABLE IF NOT EXISTS plants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  species TEXT,
  location TEXT,
  notes TEXT,
  water_every_days INTEGER NOT NULL DEFAULT 3,
  last_watered TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sensors JSONB DEFAULT '{}'::jsonb,
  sensors_updated_at TIMESTAMPTZ,
  blynk_token TEXT,
  blynk_server TEXT
);

ALTER TABLE plants ADD COLUMN IF NOT EXISTS sensors_updated_at TIMESTAMPTZ;

-- Checkups table
CREATE TABLE IF NOT EXISTS checkups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id UUID NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  photo TEXT NOT NULL,
  note TEXT,
  health_score INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'needs_attention', 'critical')),
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_plants_user_id ON plants(user_id);
CREATE INDEX IF NOT EXISTS idx_checkups_plant_id ON checkups(plant_id);
CREATE INDEX IF NOT EXISTS idx_checkups_user_id ON checkups(user_id);

-- Row Level Security (RLS) Policies
ALTER TABLE plants ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkups ENABLE ROW LEVEL SECURITY;

-- Plants policies
DROP POLICY IF EXISTS "Users can view their own plants" ON plants;
CREATE POLICY "Users can view their own plants"
  ON plants FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own plants" ON plants;
CREATE POLICY "Users can insert their own plants"
  ON plants FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own plants" ON plants;
CREATE POLICY "Users can update their own plants"
  ON plants FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own plants" ON plants;
CREATE POLICY "Users can delete their own plants"
  ON plants FOR DELETE
  USING (auth.uid() = user_id);

-- Checkups policies
DROP POLICY IF EXISTS "Users can view their own checkups" ON checkups;
CREATE POLICY "Users can view their own checkups"
  ON checkups FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own checkups" ON checkups;
CREATE POLICY "Users can insert their own checkups"
  ON checkups FOR INSERT
  WITH CHECK (auth.uid() = user_id AND EXISTS (
    SELECT 1 FROM plants WHERE plants.id = checkups.plant_id AND plants.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Users can update their own checkups" ON checkups;
CREATE POLICY "Users can update their own checkups"
  ON checkups FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own checkups" ON checkups;
CREATE POLICY "Users can delete their own checkups"
  ON checkups FOR DELETE
  USING (auth.uid() = user_id);
