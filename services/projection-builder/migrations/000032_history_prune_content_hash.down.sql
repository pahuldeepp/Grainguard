DO $$ BEGIN
 RAISE EXCEPTION 'rollback refused: content integrity guard must be preserved';
END $$;
