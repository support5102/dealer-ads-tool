/**
 * Tier 1 Config Tests — validates environment variable handling.
 *
 * Tests: src/utils/config.js (validateEnv, REQUIRED_VARS)
 * No external deps — uses fake env objects.
 */

const { validateEnv, REQUIRED_VARS } = require('../../src/utils/config');

// A complete valid env for reuse across tests
function validEnv() {
  return {
    GOOGLE_ADS_DEVELOPER_TOKEN: 'test-dev-token',
    GOOGLE_ADS_CLIENT_ID: 'test-client-id',
    GOOGLE_ADS_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'test-session-secret',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
  };
}

describe('validateEnv', () => {
  test('returns frozen config when all required vars are present', () => {
    const config = validateEnv(validEnv());

    expect(config.googleAds.developerToken).toBe('test-dev-token');
    expect(config.googleAds.clientId).toBe('test-client-id');
    expect(config.googleAds.clientSecret).toBe('test-client-secret');
    expect(config.session.secret).toBe('test-session-secret');
    expect(config.claude.apiKey).toBe('test-anthropic-key');
    expect(Object.isFrozen(config)).toBe(true);
  });

  test('deep freezes nested config objects', () => {
    const config = validateEnv(validEnv());

    expect(Object.isFrozen(config.googleAds)).toBe(true);
    expect(Object.isFrozen(config.session)).toBe(true);
    expect(Object.isFrozen(config.app)).toBe(true);
    expect(Object.isFrozen(config.claude)).toBe(true);

    // Verify mutations are silently ignored (strict mode would throw)
    config.googleAds.developerToken = 'hijacked';
    expect(config.googleAds.developerToken).toBe('test-dev-token');
  });

  test('throws when a single required var is missing', () => {
    const env = validEnv();
    delete env.ANTHROPIC_API_KEY;

    expect(() => validateEnv(env)).toThrow('ANTHROPIC_API_KEY');
    expect(() => validateEnv(env)).toThrow('Missing required environment variables');
  });

  test('throws when multiple required vars are missing', () => {
    const env = validEnv();
    delete env.GOOGLE_ADS_DEVELOPER_TOKEN;
    delete env.SESSION_SECRET;

    expect(() => validateEnv(env)).toThrow('GOOGLE_ADS_DEVELOPER_TOKEN');
    expect(() => validateEnv(env)).toThrow('SESSION_SECRET');
  });

  test('throws when a required var is an empty string', () => {
    const env = validEnv();
    env.GOOGLE_ADS_CLIENT_ID = '';

    expect(() => validateEnv(env)).toThrow('GOOGLE_ADS_CLIENT_ID');
  });

  test('throws when a required var is whitespace only', () => {
    const env = validEnv();
    env.GOOGLE_ADS_CLIENT_SECRET = '   ';

    expect(() => validateEnv(env)).toThrow('GOOGLE_ADS_CLIENT_SECRET');
  });

  test('applies default APP_URL when not provided', () => {
    const config = validateEnv(validEnv());

    expect(config.app.url).toBe('http://localhost:3000');
  });

  test('uses provided APP_URL when set', () => {
    const env = { ...validEnv(), APP_URL: 'https://myapp.railway.app' };
    const config = validateEnv(env);

    expect(config.app.url).toBe('https://myapp.railway.app');
  });

  test('applies default PORT when not provided', () => {
    const config = validateEnv(validEnv());

    expect(config.app.port).toBe(3000);
  });

  test('parses PORT as integer when provided', () => {
    const env = { ...validEnv(), PORT: '8080' };
    const config = validateEnv(env);

    expect(config.app.port).toBe(8080);
  });

  test('applies default Claude model when not provided', () => {
    const config = validateEnv(validEnv());

    expect(config.claude.model).toBe('claude-sonnet-4-20250514');
  });

  test('uses provided CLAUDE_MODEL when set', () => {
    const env = { ...validEnv(), CLAUDE_MODEL: 'claude-haiku-4-5-20251001' };
    const config = validateEnv(env);

    expect(config.claude.model).toBe('claude-haiku-4-5-20251001');
  });
});

describe('REQUIRED_VARS', () => {
  test('contains exactly 5 required variables', () => {
    expect(REQUIRED_VARS).toHaveLength(5);
  });

  test('includes all expected variable names', () => {
    expect(REQUIRED_VARS).toContain('GOOGLE_ADS_DEVELOPER_TOKEN');
    expect(REQUIRED_VARS).toContain('GOOGLE_ADS_CLIENT_ID');
    expect(REQUIRED_VARS).toContain('GOOGLE_ADS_CLIENT_SECRET');
    expect(REQUIRED_VARS).toContain('SESSION_SECRET');
    expect(REQUIRED_VARS).toContain('ANTHROPIC_API_KEY');
  });
});
