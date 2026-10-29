-- Resumes Claude Code, Codex, and pi in their panes after the Rex server restarts. See the
-- `rex-resume.ts` section of home/agents/pi/README.md.
--
-- Each agent writes a JSON record named for its pane's block to ~/.local/state/rex/agents, with
-- `agent`, `session`, `file`, `cwd`, and its process's `pid`. init.lua requires this file, which starts it as a script
-- that follows every session. The script deletes a record once its pane is back at the shell's
-- prompt. When the server restarts, it types each record's resume command into its pane, then
-- deletes records whose pane is gone.

local shared = require("lib.shared")

local TERMINAL, STATE_DIR = shared.TERMINAL, shared.STATE_DIR
local fail, read_json, write_json = shared.fail, shared.read_json, shared.write_json
local exists, basename, tildify, gone = shared.exists, shared.basename, shared.tildify, shared.gone
local processes = shared.processes

local RECORDS = STATE_DIR .. "/agents"
-- The server instance whose panes were last resumed.
local STATE = STATE_DIR .. "/agent_resume.json"
local LOG = STATE_DIR .. "/agent_resume.log"

-- The label the running script gives its connection, so a new one finds the old.
local LABEL = "agent-resume"

local SELF = shared.source_path("agent_resume.lua")

-- agent_resume.json beside this file sets `rex`, the CLI that runs this file, since the server's
-- PATH has no rex.
local SETTINGS = SELF:match("^(.*)/[^/]+$") .. "/agent_resume.json"

-- How long a restarted server's panes get to come back.
local RESTORE_SECONDS = 60

-- How long a pane's processes must settle before the script checks whether its agent quit.
local SETTLE_SECONDS = 2

-- How often every record is checked, for changes no event reports.
local SWEEP_SECONDS = 60

-- How long a resumed agent gets to start and write its own record before its record counts as
-- stale.
local RESUME_SECONDS = 60

-- Shells that run the resume line, which joins its commands with `&&`.
local SHELLS = { bash = true, dash = true, fish = true, ksh = true, sh = true, zsh = true }

-- Session IDs are typed into a shell, so only IDs made of letters, digits, `.`, `_`, and `-` are
-- accepted.
local function plain(id)
  return type(id) == "string" and id:match("^[%w._-]+$") ~= nil
end

-- Wraps text in single quotes. Returns nil when it has a quote or a backslash, which each shell
-- reads differently inside them, or a control character, which the terminal would act on.
local function quote(text)
  if type(text) ~= "string" or text:match("[%c'\\]") then
    return nil
  end

  return "'" .. text .. "'"
end

-- A session with no file yet has no messages, so the agent starts fresh.
local function saved(record)
  return type(record.file) == "string" and exists(record.file)
end

local function resumes(program, resume)
  return function(record)
    return saved(record) and (resume .. " " .. record.session) or program
  end
end

-- pi takes the session's path, which finds it wherever it's stored, as with --session-dir. Returns
-- nil when the path can't be quoted.
local function resume_pi(record)
  if not saved(record) then
    return "pi"
  end

  local file = quote(record.file)

  return file and ("pi --session " .. file)
end

-- Each agent's resume command, by the name its process runs as, or nil when it can't be typed.
local AGENTS = {
  pi = resume_pi,
  claude = resumes("claude", "claude --resume"),
  codex = resumes("codex", "codex resume"),
}

---------------------------------------------------------------------------------------------------
-- Started from the configuration

-- Only a script has rex.after, so without it the configuration is loading this file. A missing
-- `rex` setting or a failed start is logged rather than raised, so the rest of the configuration
-- still loads.
if rex.after == nil then
  local cli = (read_json(SETTINGS) or {}).rex

  if cli == nil then
    rex.log("error", ("Couldn't start agent_resume.lua: %s doesn't set `rex`."):format(tildify(SETTINGS)))

    return
  end

  -- Detached, so it outlives loading the configuration.
  local script = 'mkdir -p "$(dirname "$3")" && exec "$1" --autostart=false do "$2" --all >"$3" 2>&1'
  local _, err = rex.exec.start({ "sh", "-c", script, "agent_resume", cli, SELF, LOG }, { detach = true })

  if err ~= nil then
    rex.log("error", "Couldn't start agent_resume.lua: " .. tostring(err))
  end

  return
end

---------------------------------------------------------------------------------------------------
-- Records

local function record_path(block_id)
  return RECORDS .. "/" .. block_id:gsub("^block:", "")
end

local function remove_record(block_id)
  local path = record_path(block_id)
  local removed, err = os.remove(path)

  if not removed and exists(path) then
    fail(("Removing %s failed: %s"):format(tildify(path), tostring(err)))
  end
end

-- A pane's record, or nil when it has none. A record this file can't resume is deleted.
local function read_record(block_id)
  local path = record_path(block_id)
  local record = read_json(path)
  local valid = record ~= nil and AGENTS[record.agent] ~= nil and plain(record.session)
    and type(record.pid) == "number"
    and (record.resumed == nil or type(record.resumed_at) == "number")

  if record ~= nil and not valid then
    rex.log("warn", ("Deleting %s, which isn't a record this can resume."):format(tildify(path)))
    remove_record(block_id)

    return nil
  end

  return record
end

-- The block IDs that have records. Writers rename a temporary file into place, and each names it
-- with `.tmp` after the record's name.
local function recorded()
  local listing = shared.exec({ "ls", RECORDS })

  if not listing.ok then
    fail(("Listing %s failed: %s"):format(tildify(RECORDS), shared.trim(listing.stderr)))
  end

  local names = listing.stdout
  local blocks = {}

  for name in names:gmatch("[^\n]+") do
    if not name:find(".tmp", 1, true) then
      blocks[#blocks + 1] = "block:" .. name
    end
  end

  return blocks
end

---------------------------------------------------------------------------------------------------
-- Panes

-- A process's name and the one it shows, such as `claude` for a wrapper that `exec -a`s.
local function names(process)
  local argv0 = process.argv0 and basename((process.argv0:gsub("^%-", ""))) or nil

  return process.name, argv0
end

local function runs(result, agent)
  local all = { result.child, result.foreground }

  for _, process in ipairs(result.ancestors or {}) do
    all[#all + 1] = process
  end

  for _, process in ipairs(all) do
    local name, argv0 = names(process)

    if name == agent or argv0 == agent then
      return true
    end
  end

  return false
end

local function shell(process)
  local name, argv0 = names(process)

  return SHELLS[name] or SHELLS[argv0] or false
end

-- Whether the pane is at its own shell's prompt. Rex runs the shell under `login`, which isn't a
-- shell, so a shell among the ancestors means the foreground one runs inside it.
local function idle_shell(result)
  if result.child == nil or result.foreground == nil or not shell(result.foreground) then
    return false
  end

  for _, process in ipairs(result.ancestors or {}) do
    if shell(process) then
      return false
    end
  end

  return true
end

-- A script hears every session with --all, but can call one only once attached to it. Returns
-- false when the session is gone.
local function attach(session_id)
  local ok, err = shared.attach(session_id)

  if not ok and not gone(err) then
    fail(("Attaching to session %s failed: %s"):format(session_id, tostring(err)))
  end

  return ok == true
end

-- A session's panes, or none once the session is gone.
local function blocks_of(session_id)
  if not attach(session_id) then
    return {}
  end

  local list, err = rex.call("session.list_blocks", { session_id = session_id })

  if list == nil then
    if gone(err) then
      return {}
    end

    fail(("Listing the panes of session %s failed: %s"):format(session_id, tostring(err)))
  end

  return list.blocks or {}
end

-- Each live pane's session, by block ID.
local function panes()
  local sessions = shared.call("session.list", {}).sessions or {}
  local found = {}

  for _, session in ipairs(sessions) do
    local blocks = blocks_of(session.session_id)

    for _, block in ipairs(blocks) do
      found[block.block_id] = session.session_id
    end
  end

  return found
end

---------------------------------------------------------------------------------------------------
-- Following agents

-- True while a restarted server's panes are being resumed, when panes have shells but no agents yet.
local restoring = false

-- Whether the record's agent still runs, which includes one suspended with Ctrl+Z. ps fails for a
-- process that exited, and the name check skips a process that reused its ID.
local function agent_runs(record)
  local listed = shared.exec({ "ps", "-o", "args=", "-p", tostring(record.pid) })
  local argv0 = listed.stdout:match("^%s*(%S+)")

  return listed.ok and argv0 ~= nil and basename((argv0:gsub("^%-", ""))) == record.agent
end

-- Whether a record was resumed so recently that its agent may not have written its own yet.
local function starting(record)
  return record.resumed ~= nil and os.time() - record.resumed_at < RESUME_SECONDS
end

-- Deletes a pane's record once the pane is back at its shell's prompt and the agent has exited,
-- which means it was quit, or a resumed agent didn't start. A pane the server is taking down has no
-- live shell, or no answer. The record is read again before it's deleted, in case an agent wrote a
-- new one meanwhile.
local function check(session_id, block_id)
  if restoring then
    return
  end

  local record = read_record(block_id)

  if record == nil or starting(record) or not attach(session_id) then
    return
  end

  local result = processes(session_id, block_id)

  if result == nil or not idle_shell(result) or agent_runs(record) then
    return
  end

  local now = read_record(block_id)

  if now ~= nil and now.pid == record.pid and now.session == record.session then
    remove_record(block_id)
  end
end

local pending = {}

-- Checks a pane once its processes have settled.
local function settle(session_id, block_id)
  if pending[block_id] ~= nil then
    pending[block_id]:cancel()
  end

  pending[block_id] = rex.after(SETTLE_SECONDS, function()
    pending[block_id] = nil
    check(session_id, block_id)
  end)
end

-- Checks every record, and deletes the records of closed panes. An agent writes its record after
-- its pane exists, so records are listed before panes.
local function sweep()
  if restoring then
    return
  end

  local blocks = recorded()
  local live = panes()

  for _, block_id in ipairs(blocks) do
    if live[block_id] == nil then
      remove_record(block_id)
    else
      check(live[block_id], block_id)
    end
  end
end

---------------------------------------------------------------------------------------------------
-- Resuming

-- `cd` into the record's directory, then the resume command. Returns false or nil when either can't
-- be typed into a shell.
local function resume_line(record)
  local command = AGENTS[record.agent](record)
  local cwd = type(record.cwd) == "string" and record.cwd:match("^/") and quote(record.cwd)

  return command and cwd and ("cd %s && %s\r"):format(cwd, command)
end

-- Types a line into a pane. Returns false when the pane closed meanwhile.
local function type_line(session_id, block_id, line)
  local where = { session_id = session_id, block_id = block_id, data = line }
  local written, err = rex.block.call(TERMINAL, "write", where)

  if written == nil then
    if gone(err) then
      return false
    end

    fail(("Typing into pane %s failed: %s"):format(block_id, tostring(err)))
  end

  return true
end

-- Resumes one pane's agent once the pane is back at its shell. Returns true when the pane needs
-- nothing more: it has no record, its agent runs, or this server resumed it already. `resumed`
-- marks a record this server resumed, so a script that replaces this one doesn't type it again.
-- It's written before the command is typed, so it never overwrites the record the agent writes
-- when it starts.
local function resume_pane(block_id, session_id, instance_id)
  local record = read_record(block_id)
  local result = session_id and processes(session_id, block_id)

  if record == nil or record.resumed == instance_id or (result and runs(result, record.agent)) then
    return true
  end

  if not (result and idle_shell(result)) then
    return false
  end

  local line = resume_line(record)

  if not line then
    rex.log("warn", ("Deleting %s's record: its directory or session can't be typed."):format(block_id))
    remove_record(block_id)

    return true
  end

  record.resumed = instance_id
  record.resumed_at = os.time()
  write_json(record_path(block_id), record)

  if not type_line(session_id, block_id, line) then
    return false
  end

  rex.log(("Resumed %s in %s"):format(record.agent, block_id))

  return true
end

-- Waits for each recorded pane to come back, and resumes its agent.
local function resume(instance_id)
  local waiting = {}
  local blocks = recorded()

  for _, block_id in ipairs(blocks) do
    waiting[block_id] = true
  end

  local deadline = os.time() + RESTORE_SECONDS
  local live = {}

  while next(waiting) ~= nil and os.time() < deadline do
    live = panes()

    for block_id in pairs(waiting) do
      if resume_pane(block_id, live[block_id], instance_id) then
        waiting[block_id] = nil
      end
    end

    if next(waiting) ~= nil then
      rex.sleep(1)
    end
  end

  -- Panes that didn't come back are gone.
  for block_id in pairs(waiting) do
    if live[block_id] == nil then
      remove_record(block_id)
    end
  end
end

---------------------------------------------------------------------------------------------------
-- Running as the script

-- This script's own client, found by its process.
local function own_client(clients)
  local me = shared.own_pid()

  for _, client in ipairs(clients) do
    if client.principal and tostring(client.principal.pid) == me then
      return client.client_id
    end
  end

  fail(("No Rex client has this script's process %s."):format(me))
end

-- Ends another copy of this script. When kill fails, `kill -0` tells whether the copy exited
-- meanwhile, which is fine, or still runs.
local function stop_copy(pid)
  local killed = shared.exec({ "kill", tostring(pid) })

  if not killed.ok and shared.exec({ "kill", "-0", tostring(pid) }, { stderr = false }).ok then
    fail(("Stopping the older agent_resume.lua %s failed: %s"):format(pid, shared.trim(killed.stderr)))
  end
end

-- Stops older copies of this script, or this one if a newer one runs. Rex orders client IDs by when
-- they connected.
local function take_over()
  shared.call("client.set_label", { label = LABEL })

  local clients = shared.call("client.list", {}).clients or {}
  local mine = own_client(clients)

  for _, client in ipairs(clients) do
    local label = client.info and client.info.label
    local pid = client.principal and client.principal.pid

    if label == LABEL and client.client_id ~= mine and pid ~= nil then
      if client.client_id > mine then
        rex.stop(0)
      end

      stop_copy(pid)
    end
  end
end

take_over()

local made = shared.exec({ "mkdir", "-p", RECORDS })

if not made.ok then
  fail(("Making %s failed: %s"):format(tildify(RECORDS), shared.trim(made.stderr)))
end

rex.on("terminal.process_changed", function(ctx)
  settle(ctx.session_id, ctx.block_id)
end)

rex.every(SWEEP_SECONDS, sweep)

local instance_id = shared.call("server.status", {}).instance_id
local state = read_json(STATE) or {}

if state.instance_id ~= instance_id then
  restoring = true
  rex.log("New server " .. instance_id .. ", resuming agents")
  resume(instance_id)
  write_json(STATE, { instance_id = instance_id })
  restoring = false
end

rex.log("Following agents")
