-- Preserve existing rows; only verified providers populate account email.
-- No invented email address is assigned to historical profiles.
ALTER TABLE profiles ADD COLUMN email TEXT CHECK(email IS NULL OR length(email) BETWEEN 3 AND 320);
CREATE UNIQUE INDEX profiles_verified_email ON profiles(email) WHERE email IS NOT NULL;
