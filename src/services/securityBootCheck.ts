/**
 * Boot-time security sanity checks. Fail-fast if production secrets aren't set.
 */
export function runSecurityBootCheck() {
  const errors: string[] = [];
  const warnings: string[] = [];

  const access = process.env.JWT_SECRET || '';
  const refresh = process.env.JWT_REFRESH_SECRET || '';

  if (access.length < 32) {
    errors.push('JWT_SECRET must be at least 32 characters');
  }
  if (refresh.length < 32) {
    errors.push('JWT_REFRESH_SECRET must be at least 32 characters');
  }
  if (access === refresh) {
    errors.push('JWT_SECRET and JWT_REFRESH_SECRET must differ');
  }

  // Known dev/default secrets — never allow in production.
  const knownDefaults = [
    'change-me-in-production',
    'change-me-refresh-in-production',
    'bpmz-local-secret-change-in-production',
    'bpmz-local-refresh-secret-change-in-production',
    'your-super-secret-key-change-in-production',
    'your-super-secret-refresh-key-change-in-production',
  ];
  if (process.env.NODE_ENV === 'production') {
    if (knownDefaults.includes(access) || knownDefaults.includes(refresh)) {
      errors.push('Refusing to start in production with default JWT secrets');
    }
    if (process.env.CORS_ORIGINS === '*' || !process.env.CORS_ORIGINS) {
      errors.push('CORS_ORIGINS must be an explicit allowlist in production');
    }
    // Admin bootstrap password: never allow the well-known default in production.
    const adminPass = process.env.ADMIN_PASSWORD || '';
    if (!adminPass) {
      errors.push('ADMIN_PASSWORD must be set in production (strong, 10+ chars)');
    } else if (adminPass === 'admin123') {
      errors.push('ADMIN_PASSWORD must not be the default "admin123" in production');
    } else if (adminPass.length < 10) {
      errors.push('ADMIN_PASSWORD must be at least 10 characters');
    }
  } else {
    if (knownDefaults.includes(access) || knownDefaults.includes(refresh)) {
      warnings.push('Default JWT secrets in use (OK for local dev only)');
    }
  }

  if ((process.env.INVITE_CODES || '').split(',').filter(Boolean).length === 0) {
    warnings.push('No INVITE_CODES configured — registration is open to anyone with the endpoint');
  }

  if (errors.length) {
    console.error('🔒 Security check FAILED:');
    for (const e of errors) console.error('   • ' + e);
    process.exit(1);
  }
  if (warnings.length) {
    console.warn('🔒 Security warnings:');
    for (const w of warnings) console.warn('   • ' + w);
  } else {
    console.log('🔒 Security check passed');
  }
}
