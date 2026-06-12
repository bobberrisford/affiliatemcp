import { setTelemetryConsent, telemetryConsent, telemetryFilePath } from '../shared/telemetry.js';

function out(line = ''): void {
  process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
}

export function runTelemetry(action?: string): number {
  switch (action) {
    case 'enable':
      setTelemetryConsent(true);
      out('Anonymous usage telemetry enabled.');
      out('A random installation identifier rotates monthly. No affiliate data is collected.');
      return 0;
    case 'disable':
      setTelemetryConsent(false);
      if (telemetryConsent() === 'enabled') {
        out(
          'Local telemetry state was deleted, but AFFILIATE_MCP_TELEMETRY keeps telemetry enabled.',
        );
        out('Disable telemetry in the MCP host settings or remove that environment variable.');
        return 1;
      }
      out(
        'Anonymous usage telemetry disabled. Pending counters and the monthly identifier were deleted.',
      );
      return 0;
    case 'status':
    case undefined:
      out(`Telemetry: ${telemetryConsent()}`);
      out(`State file: ${telemetryFilePath()}`);
      return 0;
    default:
      out('Usage: affiliate-networks-mcp telemetry [status|enable|disable]');
      return 2;
  }
}
