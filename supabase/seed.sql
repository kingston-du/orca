-- Local development deliberately permits founder/bootstrap accounts without an
-- invitation. Hosted environments keep the migration default
-- `invitation_required`; this seed is not included in linked db pushes.
update private.signup_gate_config
set mode = 'development_open',
    updated_at = statement_timestamp()
where singleton;
