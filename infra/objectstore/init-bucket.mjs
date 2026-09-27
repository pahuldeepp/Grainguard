// Creates the private local test bucket (idempotent). Usage: node --env-file=.env init-bucket.mjs
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export const LOCAL_ENDPOINT = "http://127.0.0.1:59000";
export const LOCAL_BUCKET = "greenguard-audit-exports-local";

export function localClient(env = process.env) {
  if (!env.OBJECTSTORE_ROOT_USER || !env.OBJECTSTORE_ROOT_PASSWORD)
    throw new Error(
      "OBJECTSTORE_ROOT_USER and OBJECTSTORE_ROOT_PASSWORD are required (make bootstrap)",
    );
  return new S3Client({
    region: "us-east-1",
    endpoint: LOCAL_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.OBJECTSTORE_ROOT_USER,
      secretAccessKey: env.OBJECTSTORE_ROOT_PASSWORD,
    },
  });
}

async function exists(client) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: LOCAL_BUCKET }));
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound")
      return false;
    throw error;
  }
}

export async function ensureBucket(client, attempts = 30) {
  for (let attempt = 1; ; attempt++) {
    try {
      if (!(await exists(client)))
        await client.send(new CreateBucketCommand({ Bucket: LOCAL_BUCKET }));
      break;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await client.send(
    new PutBucketVersioningCommand({
      Bucket: LOCAL_BUCKET,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  // Exports expire after 7 days in the API; the lifecycle rule removes the bytes a day later.
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: LOCAL_BUCKET,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: "expire-audit-exports",
            Status: "Enabled",
            Filter: { Prefix: "tenants/" },
            Expiration: { Days: 8 },
            NoncurrentVersionExpiration: { NoncurrentDays: 1 },
          },
        ],
      },
    }),
  );
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await ensureBucket(localClient());
  console.log(`bucket ${LOCAL_BUCKET} ready at ${LOCAL_ENDPOINT}`);
}
