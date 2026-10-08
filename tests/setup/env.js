// Loaded by Jest's `setupFiles` BEFORE the test framework and any test file.
// index.js does `JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)` and reads
// several other env vars at require-time, so these must exist first.
 
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
 
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'awh-test-project',
  client_email: 'test@awh-test-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nFAKE-TEST-KEY\n-----END PRIVATE KEY-----\n',
});
 
process.env.RAZORPAY_KEY_ID = 'rzp_test_key_id';
process.env.RAZORPAY_KEY_SECRET = 'rzp_test_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test_secret';
 
process.env.EMAIL_USER = 'noreply@awhbharat.org';
process.env.EMAIL_PASS = 'fake-app-password';
process.env.EMAIL_HOST = 'smtp.gmail.com';
process.env.EMAIL_PORT = '587';
 