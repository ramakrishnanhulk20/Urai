-- SERV began billing the balance probe as a real call on 25 Sep 2026, so the probe is gone and this flag has no meaning.
DELETE FROM app_flags WHERE name = 'probe_ran';
