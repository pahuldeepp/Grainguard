package modelgateway

import "testing"

const migrationHost = "greenguard-test.abc123.us-east-1.rds.amazonaws.com"
const migrationDSN = "postgresql://model_gateway_migrator:fixture-password@" + migrationHost + ":5432/greenguard_ai_usage?sslmode=verify-full&sslrootcert=%2Frds-ca%2Fca.pem&connect_timeout=5"

func TestValidateMigrationDSNAcceptsExactOwnerContract(t *testing.T) {
	if err := ValidateMigrationDSN(migrationDSN, migrationHost); err != nil {
		t.Fatal(err)
	}
}

func TestValidateMigrationDSNRejectsWrongDatabaseIdentityAndTLS(t *testing.T) {
	invalid := []string{
		"postgresql://model_gateway_app:fixture-password@" + migrationHost + ":5432/greenguard_ai_usage?sslmode=verify-full&sslrootcert=%2Frds-ca%2Fca.pem",
		"postgresql://model_gateway_migrator:fixture-password@attacker.example.net:5432/greenguard_ai_usage?sslmode=verify-full&sslrootcert=%2Frds-ca%2Fca.pem",
		"postgresql://model_gateway_migrator:fixture-password@" + migrationHost + ":5432/postgres?sslmode=verify-full&sslrootcert=%2Frds-ca%2Fca.pem",
		"postgresql://model_gateway_migrator:fixture-password@" + migrationHost + ":5432/greenguard_ai_usage?sslmode=require&sslrootcert=%2Frds-ca%2Fca.pem",
		migrationDSN + "&host=attacker.example.net",
		"postgresql://model_gateway_migrator:fixture-password@" + migrationHost + ":5433/greenguard_ai_usage?sslmode=verify-full&sslrootcert=%2Frds-ca%2Fca.pem",
		migrationDSN + "&connect_timeout=11",
	}
	for _, dsn := range invalid {
		if err := ValidateMigrationDSN(dsn, migrationHost); err == nil {
			t.Fatalf("expected DSN to be rejected")
		}
	}
	if err := ValidateMigrationDSN(migrationDSN, "database.internal"); err == nil {
		t.Fatal("expected non-RDS target to be rejected")
	}
}
