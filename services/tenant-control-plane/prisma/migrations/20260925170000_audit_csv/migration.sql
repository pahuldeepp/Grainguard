ALTER TABLE audit_export_jobs DROP CONSTRAINT audit_export_jobs_format_check;
ALTER TABLE audit_export_jobs ADD CONSTRAINT audit_export_jobs_format_check
 CHECK (format IN ('jsonl','csv'));
