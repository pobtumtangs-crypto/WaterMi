-- Supabase Database Schema for WaterMI
-- Synchronized with supabase/migrations/ (preferred source of truth via `supabase db push`)

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Plants table
CREATE TABLE IF NOT EXISTS plants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  species TEXT CHECK (species IS NULL OR length(species) <= 120),
  location TEXT CHECK (location IS NULL OR length(location) <= 120),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  water_every_days INTEGER NOT NULL DEFAULT 3 CHECK (water_every_days BETWEEN 1 AND 365),
  last_watered TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sensors JSONB DEFAULT '{}'::jsonb CHECK (
    sensors IS NULL
    OR (jsonb_typeof(sensors) = 'object' AND pg_column_size(sensors) <= 4096)
  ),
  sensors_updated_at TIMESTAMPTZ,
  blynk_token TEXT CHECK (blynk_token IS NULL OR length(blynk_token) <= 512),
  blynk_server TEXT CHECK (
    blynk_server IS NULL
    OR blynk_server = ''
    OR blynk_server ~* '^https://((ny3|fra1|sgp1|lon1|blr1)\.)?blynk\.cloud$'
  )
);

-- Checkups table
CREATE TABLE IF NOT EXISTS checkups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id UUID NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  photo TEXT NOT NULL CHECK (photo ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  health_score INTEGER NOT NULL CHECK (health_score BETWEEN 0 AND 100),
  status TEXT NOT NULL CHECK (status IN ('healthy', 'needs_attention', 'critical')),
  report JSONB NOT NULL CHECK (jsonb_typeof(report) = 'object' AND pg_column_size(report) <= 65536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Persistent session revocation table (survives restarts/redeployments)
CREATE TABLE IF NOT EXISTS revoked_sessions (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_plants_user_id ON plants(user_id);
CREATE INDEX IF NOT EXISTS idx_plants_user_created ON plants(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_checkups_plant_id ON checkups(plant_id);
CREATE INDEX IF NOT EXISTS idx_checkups_user_id ON checkups(user_id);
CREATE INDEX IF NOT EXISTS idx_checkups_plant_date ON checkups(plant_id, date);
CREATE INDEX IF NOT EXISTS idx_revoked_sessions_user_id ON revoked_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_revoked_sessions_expires_at ON revoked_sessions(expires_at);

-- Ownership immutability triggers
CREATE OR REPLACE FUNCTION prevent_ownership_reassignment()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'user_id is immutable';
  END IF;
  IF TG_TABLE_NAME = 'checkups' AND NEW.plant_id IS DISTINCT FROM OLD.plant_id THEN
    RAISE EXCEPTION 'plant_id is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plants_immutable_owner ON plants;
CREATE TRIGGER trg_plants_immutable_owner
  BEFORE UPDATE ON plants
  FOR EACH ROW
  EXECUTE FUNCTION prevent_ownership_reassignment();

DROP TRIGGER IF EXISTS trg_checkups_immutable_owner ON checkups;
CREATE TRIGGER trg_checkups_immutable_owner
  BEFORE UPDATE ON checkups
  FOR EACH ROW
  EXECUTE FUNCTION prevent_ownership_reassignment();

-- Row Level Security (RLS) Policies
ALTER TABLE plants ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkups ENABLE ROW LEVEL SECURITY;
ALTER TABLE revoked_sessions ENABLE ROW LEVEL SECURITY;

-- Plants policies
DROP POLICY IF EXISTS "Users can view their own plants" ON plants;
CREATE POLICY "Users can view their own plants"
  ON plants FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own plants" ON plants;
CREATE POLICY "Users can insert their own plants"
  ON plants FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own plants" ON plants;
CREATE POLICY "Users can update their own plants"
  ON plants FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own plants" ON plants;
CREATE POLICY "Users can delete their own plants"
  ON plants FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- Checkups policies
DROP POLICY IF EXISTS "Users can view their own checkups" ON checkups;
CREATE POLICY "Users can view their own checkups"
  ON checkups FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own checkups" ON checkups;
CREATE POLICY "Users can insert their own checkups"
  ON checkups FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id AND EXISTS (
      SELECT 1 FROM plants WHERE plants.id = checkups.plant_id AND plants.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can update their own checkups" ON checkups;
CREATE POLICY "Users can update their own checkups"
  ON checkups FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id AND EXISTS (
      SELECT 1 FROM plants WHERE plants.id = checkups.plant_id AND plants.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can delete their own checkups" ON checkups;
CREATE POLICY "Users can delete their own checkups"
  ON checkups FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- Revoked sessions policies
DROP POLICY IF EXISTS "Users can view their own revoked sessions" ON revoked_sessions;
CREATE POLICY "Users can view their own revoked sessions"
  ON revoked_sessions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can revoke their own sessions" ON revoked_sessions;
CREATE POLICY "Users can revoke their own sessions"
  ON revoked_sessions FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can prune their own revoked sessions" ON revoked_sessions;
CREATE POLICY "Users can prune their own revoked sessions"
  ON revoked_sessions FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- Storage bucket for plant photos
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('plant-photos', 'plant-photos', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storage policies
DROP POLICY IF EXISTS "Users can upload their own photos" ON storage.objects;
CREATE POLICY "Users can upload their own photos"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'plant-photos'
    AND auth.uid()::text = (storage.foldername(name))[1]
    AND name ~* ('^' || auth.uid()::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$')
  );

DROP POLICY IF EXISTS "Users can view their own photos" ON storage.objects;
CREATE POLICY "Users can view their own photos"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'plant-photos'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users can delete their own photos" ON storage.objects;
CREATE POLICY "Users can delete their own photos"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'plant-photos'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
