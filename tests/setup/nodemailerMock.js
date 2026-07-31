// Shared mock for `nodemailer`. index.js calls createTransport() once at
// module load if EMAIL_USER/EMAIL_PASS are set (they are, via env.js), and
// keeps the returned transporter for the lifetime of the process.

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'mock-message-id' });
const mockCreateTransport = jest.fn(() => ({ sendMail: mockSendMail }));

module.exports = {
  createTransport: mockCreateTransport,
  mockSendMail,
};