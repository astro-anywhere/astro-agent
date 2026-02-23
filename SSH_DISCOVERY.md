# SSH Machine Discovery

The Astro agent runner includes automatic SSH machine discovery to help you register remote machines from your existing SSH configuration.

## Overview

SSH discovery scans three sources to find remote machines:

1. **SSH Config** (`~/.ssh/config`) - Highest priority
2. **VS Code Remote SSH** - VS Code remote workspace configurations
3. **Known Hosts** (`~/.ssh/known_hosts`) - Previously connected hosts

## How It Works

### Discovery Process

When you run `astro-agent setup --with-ssh-config`, the agent:

1. **Parses SSH Config**: Reads `~/.ssh/config` and extracts host configurations
2. **Filters Hosts**: Skips wildcards (`*`), localhost, and `127.0.0.1`
3. **Collects Metadata**: Captures hostname, user, port, identity file, and proxy jump settings
4. **Checks VS Code**: Scans VS Code Remote SSH configurations
5. **Scans Known Hosts**: Finds additional hosts from `~/.ssh/known_hosts`
6. **Deduplicates**: Removes duplicates across all sources
7. **Prompts for Selection**: Asks which hosts to install the agent on
8. **Registers & Installs**: For each selected host:
   - Registers the machine in the Astro database
   - Checks Node.js availability (requires Node ≥18)
   - Packs and uploads the agent runner
   - Installs it globally via npm
   - Configures authentication tokens
   - Adds the agent to PATH

### Database Registration

Discovered machines are registered in the `registered_machines` table with:

- **ID**: Hardware-based or generated machine ID
- **Name**: SSH config host alias
- **Hostname**: Actual hostname or IP
- **Platform**: Detected platform (usually `linux`)
- **Environment Type**: Set to `remote`
- **User ID**: Authenticated user who owns the machine
- **Providers**: Initially empty (populated when agent starts)

## SSH Config Requirements

### Minimum Required Parameters

For a host to be discovered and usable, your SSH config should include:

```ssh
Host myserver
  HostName server.example.com
  User username
  IdentityFile ~/.ssh/id_rsa
```

### Optional Parameters

Additional parameters that enhance functionality:

```ssh
Host hpc-login
  HostName login.hpc.edu
  User myusername
  Port 22022
  IdentityFile ~/.ssh/hpc_key
  ProxyJump bastion.hpc.edu
```

### Parameters Explained

| Parameter | Required | Description |
|-----------|----------|-------------|
| `Host` | ✓ | Alias for the connection (used as machine name) |
| `HostName` | ✓ | Actual hostname or IP address |
| `User` | Recommended | Username for SSH connection |
| `Port` | Optional | SSH port (default: 22) |
| `IdentityFile` | Recommended | Path to SSH private key |
| `ProxyJump` | Optional | Bastion/jump host for connection |

## Usage

### Basic Setup

```bash
# Install with SSH discovery enabled
astro-agent setup --with-ssh-config
```

### Non-Interactive Mode

For automated setups or CI/CD:

```bash
# Setup without SSH discovery (skips interactive prompts)
astro-agent setup --non-interactive --skip-auth
```

### Example SSH Config

```ssh
# Local development server
Host devbox
  HostName 192.168.1.100
  User developer
  IdentityFile ~/.ssh/devbox_key

# HPC cluster login node
Host sherlock
  HostName login.sherlock.stanford.edu
  User username
  Port 22
  IdentityFile ~/.ssh/sherlock_key
  ProxyJump sherlock-gw

# Cloud VM
Host aws-compute
  HostName ec2-xxx-xxx-xxx-xxx.compute.amazonaws.com
  User ubuntu
  IdentityFile ~/.ssh/aws-key.pem
```

## Troubleshooting

### No Hosts Discovered

**Problem**: Setup reports "No remote hosts discovered"

**Solutions**:
1. Check that `~/.ssh/config` exists and is readable
2. Ensure hosts don't use wildcards (`*`) in the Host directive
3. Verify hosts aren't `localhost` or `127.0.0.1`
4. Look for debug output with `[ssh-discovery]` prefix

### Node.js Not Found on Remote

**Problem**: Installation fails with "Node.js not found"

**Solutions**:
1. Install Node.js ≥18 on the remote machine
2. Ensure `node` is in PATH for non-interactive shells
3. Try: `ssh <host> 'node --version'` to verify

### Registration Failed

**Problem**: "Failed to register machine to database"

**Solutions**:
1. Check backend is running: `npm run dev:backend`
2. Verify authentication is valid: `astro-agent setup` first
3. Ensure user exists in `auth.users` table
4. Check backend logs for detailed error

### Machines Not Appearing in UI

**Problem**: Registered machines don't show up in the Environments page

**Solutions**:
1. Check RLS policies allow user to view their machines
2. Verify machine is registered: Query `registered_machines` table
3. Ensure backend is in Server Mode (Supabase configured)
4. Check browser console for errors

### Database Schema

The `registered_machines` table structure:

```sql
CREATE TABLE registered_machines (
  id TEXT PRIMARY KEY,                         -- Machine ID (hw-based or generated)
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                          -- Display name (from SSH Host)
  hostname TEXT NOT NULL,                      -- Actual hostname/IP
  platform TEXT NOT NULL,                      -- OS platform (linux, darwin, etc.)
  environment_type environment_type NOT NULL DEFAULT 'local',  -- local | remote | hpc | cloud
  providers TEXT[] NOT NULL DEFAULT '{}',      -- Available providers (claude-code, etc.)
  workspace_id TEXT,                           -- Optional workspace grouping
  is_connected BOOLEAN NOT NULL DEFAULT FALSE, -- Currently connected via WebSocket
  is_revoked BOOLEAN NOT NULL DEFAULT FALSE,   -- Machine access revoked
  refresh_token_hash TEXT NOT NULL,            -- Hashed refresh token
  metadata JSONB,                              -- Additional metadata
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS Policies
CREATE POLICY "Users can view own machines"
  ON registered_machines FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can register machines"
  ON registered_machines FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own machines"
  ON registered_machines FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY "Users can delete own machines"
  ON registered_machines FOR DELETE USING (user_id = auth.uid());
```

## Logging

SSH discovery and registration include detailed logging with prefixes:

- `[ssh-discovery]`: SSH config parsing and host discovery
- `[ssh-installer]`: Remote installation process
- `[machines-store]`: Database registration
- `[setup]`: Setup command orchestration

Enable verbose output by checking console logs during setup.

## Security Considerations

1. **SSH Keys**: Ensure IdentityFile permissions are `600` (read-write for owner only)
2. **Token Storage**: Tokens are stored in `~/.astro/config.json` on remote machines
3. **Network Access**: Remote machines must reach the Astro backend (check firewall rules)
4. **RLS Policies**: Database enforces user-scoped access to machines

## Related Files

- `packages/agent-runner/src/lib/ssh-discovery.ts` - Discovery logic
- `packages/agent-runner/src/lib/ssh-installer.ts` - Remote installation
- `packages/agent-runner/src/commands/setup.ts` - Setup command
- `server/lib/registered-machines-store.ts` - Database operations
- `server/routes/device-auth.ts` - Machine registration API

## Future Enhancements

- **Auto-discovery daemon**: Background service to detect new SSH hosts
- **Agent auto-update**: Push updates to remote agents
- **Batch operations**: Install on all discovered hosts at once
- **Cloud provider integration**: Auto-discover EC2, GCE, Azure VMs
