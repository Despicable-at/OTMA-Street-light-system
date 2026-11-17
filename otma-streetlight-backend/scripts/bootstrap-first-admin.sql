-- ONE-TIME FIRST ADMINISTRATOR BOOTSTRAP.
-- First create/invite the user in Supabase Dashboard > Authentication > Users.
-- Then replace the email literal below with that exact account email and run this
-- in Supabase Dashboard > SQL Editor while signed in as the project owner.
-- Never run this through a public API or put project-owner credentials in the app.

update public.profiles
set role = 'administrator', is_active = true
where lower(email) = lower('REPLACE_WITH_FIRST_ADMIN_EMAIL@example.com');

-- Verify exactly one row was updated and inspect the resulting account:
select id, email, full_name, role, is_active
from public.profiles
where lower(email) = lower('REPLACE_WITH_FIRST_ADMIN_EMAIL@example.com');
