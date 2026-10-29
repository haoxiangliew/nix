-- Helpers for worktree.lua: running commands, files, locks, and Rex's sessions and panes. It's
-- required from the configuration and when worktree.lua runs as a script.
--
-- Rex's Lua crashes when a generic `for` gets its iterator from an expression that waits on Rex,
-- such as `for line in git(...):gmatch(...)`, so such values go in a local first.

local TERMINAL = "com.superlogical.terminal"
local SHELL = TERMINAL .. ".shell"

local HOME = os.getenv("HOME")

local STATE_DIR = (os.getenv("XDG_STATE_HOME") or (HOME .. "/.local/state")) .. "/rex"

local function fail(message)
  error(message, 0)
end

local function expand(path)
  if path == "~" or path:sub(1, 2) == "~/" then
    return HOME .. path:sub(2)
  end

  return path
end

local function trim(text)
  return (text:gsub("%s+$", ""))
end

local function basename(path)
  return path:match("([^/]+)/*$") or path
end

local function tildify(path)
  if path == HOME or path:sub(1, #HOME + 1) == HOME .. "/" then
    return "~" .. path:sub(#HOME + 1)
  end

  return path
end

-- Whether path is dir or inside it.
local function within(path, dir)
  return path == dir or path:sub(1, #dir + 1) == dir .. "/"
end

local function exec(argv, opts)
  local result, err = rex.exec(argv, opts)

  if result == nil then
    fail(err)
  end

  return result
end

local function exists(path)
  return exec({ "test", "-e", path }).ok
end

-- A JSON file's contents, or nil when it doesn't exist.
local function read_json(path)
  if not exists(path) then
    return nil
  end

  local file, open_err = io.open(path, "r")

  if file == nil then
    fail(open_err)
  end

  local text = file:read("*a")

  file:close()

  local value, err = rex.json.decode(text)

  if type(value) ~= "table" then
    fail(("%s isn't a JSON object: %s"):format(tildify(path), err or type(value)))
  end

  return value
end

-- git lists paths as they were given, so paths are compared once symlinks such as /tmp are resolved.
local function realpath(path)
  local result = exec({ "sh", "-c", 'cd -P -- "$1" && pwd', "realpath", path })

  if not result.ok then
    fail(("%s isn't a directory."):format(tildify(path)))
  end

  -- Only pwd's newline goes, since a directory's name can end in whitespace.
  return (result.stdout:gsub("\n$", ""))
end

local function slug(branch)
  return (branch:gsub("[^%w._-]+", "-"))
end

-- The process this file runs in: the Rex server for an action from the configuration, or
-- `rex do` for a script.
local pid = nil

local function own_pid()
  if pid == nil then
    pid = trim(exec({ "sh", "-c", "echo $PPID" }).stdout)
  end

  return pid
end

-- Writes text to path, and fails on any open, write, or close error.
local function write_file(path, text)
  local file, open_err = io.open(path, "w")

  if file == nil then
    fail(open_err)
  end

  local written, write_err = file:write(text)
  local closed, close_err = file:close()

  if written == nil or not closed then
    fail(("Writing %s failed: %s"):format(tildify(path), tostring(write_err or close_err)))
  end
end

-- Writes value as JSON to path, through a temporary file, so a reader never sees half of it.
local function write_json(path, value)
  local dir = path:match("^(.*)/[^/]+$")
  local made = exec({ "mkdir", "-p", dir })

  if not made.ok then
    fail(("Making %s failed: %s"):format(tildify(dir), trim(made.stderr)))
  end

  local tmp = ("%s.tmp.%s"):format(path, own_pid())

  write_file(tmp, rex.json.encode(value, { indent = true }))

  local renamed, err = os.rename(tmp, path)

  if not renamed then
    fail(("Replacing %s failed: %s"):format(tildify(path), tostring(err)))
  end
end

-- What the lock's holder wrote, or "" before it has written it.
local function lock_holder(path)
  local file = io.open(path .. "/pid", "r")

  if file == nil then
    return ""
  end

  local holder = trim(file:read("*a"))

  file:close()

  return holder
end

-- The lock directory's inode, which tells a lock from a later one at the same path.
local function lock_inode(path)
  local listed = exec({ "ls", "-di", path })

  return listed.ok and listed.stdout:match("^%s*(%d+)") or nil
end

-- An action from the configuration runs in the Rex server, which stops it after 30 seconds in a way
-- it can't catch. Its lock would then outlive it, held by the server, which still runs. So such a
-- lock also holds a time after which it's abandoned, in seconds from now. A script's lock lasts as
-- long as its process.
local ACTION_LOCK_SECONDS = 40

-- What a lock holds: the holder's process ID, and for an action from the configuration, when the
-- lock is abandoned. rex.stop exists only in scripts.
local function holder_record()
  if rex.stop == nil then
    return ("%s %d"):format(own_pid(), os.time() + ACTION_LOCK_SECONDS)
  end

  return own_pid()
end

-- Whether a lock's holder is gone: its process exited, or its time ran out.
local function holder_gone(holder)
  local holder_pid, expires = holder:match("^(%d+) ?(%d*)$")

  if holder_pid == nil then
    return false
  end

  if expires ~= "" and os.time() > tonumber(expires) then
    return true
  end

  return not exec({ "kill", "-0", holder_pid }, { stderr = false }).ok
end

-- A holder writes its process ID right after it makes the lock, so a lock that has none for this
-- many seconds belongs to a holder that stopped in between.
local PIDLESS_GRACE = 5

-- Removes the lock of a holder that died, or of one that stopped before writing its process ID.
-- One caller at a time does this, and it checks the holder again first, so it can't remove a lock
-- that another caller has just taken.
local function break_lock(path, holder, inode)
  local breaking = path .. ".break"

  if not exec({ "mkdir", breaking }).ok then
    return
  end

  if lock_holder(path) == holder and (holder ~= "" or lock_inode(path) == inode) then
    exec({ "rm", "-rf", path })
  end

  exec({ "rmdir", breaking })
end

-- A lock is a directory, which mkdir makes for one caller only, with the holder's process ID in it.
-- A holder that died leaves its lock behind, which the next caller removes.
local function lock(path, wait)
  exec({ "mkdir", "-p", STATE_DIR })

  -- Each try also runs commands, so the wait goes by the clock rather than by counting tries.
  local deadline = os.time() + wait.seconds
  local pidless, pidless_since = nil, nil

  repeat
    local made = exec({ "mkdir", path })

    -- A lock that isn't there wasn't taken, so mkdir failed for another reason, such as
    -- permissions, unless its holder released it just now.
    if not made.ok and not exists(path) then
      made = exec({ "mkdir", path })

      if not made.ok and not exists(path) then
        fail(("Taking the lock %s failed: %s"):format(tildify(path), trim(made.stderr)))
      end
    end

    if made.ok then
      write_file(path .. "/pid", holder_record())

      return
    end

    local holder = lock_holder(path)
    local inode = holder == "" and lock_inode(path) or nil

    if inode ~= pidless then
      pidless, pidless_since = inode, os.time()
    end

    local abandoned = inode ~= nil and os.time() - pidless_since >= PIDLESS_GRACE

    if holder_gone(holder) or abandoned then
      break_lock(path, holder, inode)
    else
      exec({ "sleep", tostring(wait.poll) })
    end
  until os.time() >= deadline

  fail(
    ("%s stayed locked. If no worktree action is running, remove it and %s.break."):format(
      tildify(path),
      tildify(path)
    )
  )
end

-- Runs fn while holding the lock at path, and returns its result.
local function with_lock(path, wait, fn)
  lock(path, wait)

  local ok, result = pcall(fn)
  local released = exec({ "rm", "-rf", path })

  if not released.ok then
    local after = ok and "" or (" It was released after this error: " .. tostring(result))

    fail(("Releasing the lock %s failed: %s.%s"):format(tildify(path), trim(released.stderr), after))
  end

  if not ok then
    error(result, 0)
  end

  return result
end

-- Session lookups

local function call(method, args)
  local result, err = rex.call(method, args)

  if result == nil then
    fail(("%s failed: %s"):format(method, tostring(err)))
  end

  return result
end

-- Rex ends a failed call's message with its code, such as `(status=404 code=session_not_found)`.
local function error_code(err)
  return tostring(err):match("code=([%w_]+)%)")
end

-- Whether a failed call's error says its pane or session is gone, as when it closed meanwhile.
local function gone(err)
  local code = error_code(err)

  return code == "not_found" or code == "session_not_found"
end

-- A script's connection changes only the sessions it's attached to, so it attaches to each session
-- it acts on. An action from the configuration file acts for its client, which needs none of this.
local attached = {}

-- Only scripts have rex.after, and a script run with --all and no session has no rex.session_id.
local function attach(session_id)
  if rex.after == nil or session_id == rex.session_id or attached[session_id] then
    return true
  end

  local result, err = rex.session.attach({ session_id = session_id })

  if result == nil then
    return nil, err
  end

  attached[session_id] = true

  return true
end

local function in_session(method, args)
  local ok, err = attach(args.session_id)

  if not ok then
    fail(("Attaching to %s failed: %s"):format(args.session_id, tostring(err)))
  end

  return call(method, args)
end

-- Views by session, or false for a session Rex says is gone.
local function viewer()
  local views = {}

  return function(session_id)
    if views[session_id] == nil then
      local view, err = attach(session_id)

      if view then
        view, err = rex.call("session.view", { session_id = session_id })
      end

      if view == nil and error_code(err) ~= "session_not_found" then
        fail(("Looking up session %s failed: %s"):format(session_id, tostring(err)))
      end

      views[session_id] = view or false
    end

    return views[session_id]
  end
end

local function window_in(view, window_id)
  if not view then
    return nil
  end

  for _, window in ipairs(view.windows or {}) do
    if window.window_id == window_id then
      return window
    end
  end

  return nil
end

local function window_of_block(view, block_id)
  if not view or block_id == nil then
    return nil
  end

  for _, window in ipairs(view.windows or {}) do
    for _, layer in ipairs(window.layers or {}) do
      for _, block in ipairs(layer.blocks or {}) do
        if block.block_id == block_id then
          return window
        end
      end
    end
  end

  return nil
end

-- A pane's processes, or nil once the pane or its session is gone.
local function processes(session_id, block_id)
  local where = { session_id = session_id, block_id = block_id }
  local result, err = rex.block.call(TERMINAL, "process", where)

  if result == nil and not gone(err) then
    fail(("Looking up the processes in pane %s failed: %s"):format(block_id, tostring(err)))
  end

  return result
end

-- Where a pane's terminal is, or nil when Rex doesn't know. The second value is true when the pane
-- or its session is gone.
local function block_cwd(session_id, block_id)
  if block_id == nil then
    return nil
  end

  local where = { session_id = session_id, block_id = block_id }
  local process = processes(session_id, block_id)

  if process == nil then
    return nil, true
  end

  if process.foreground ~= nil and process.foreground.cwd ~= nil then
    return process.foreground.cwd
  end

  local pwd, pwd_err = rex.block.call(TERMINAL, "pwd", where)

  if pwd == nil then
    if gone(pwd_err) then
      return nil, true
    end

    fail(("Looking up the directory of pane %s failed: %s"):format(block_id, tostring(pwd_err)))
  end

  if pwd.pwd ~= nil then
    return (pwd.pwd:gsub("^file://[^/]*", ""):gsub("%%(%x%x)", function(hex)
      return string.char(tonumber(hex, 16))
    end))
  end

  return nil
end

local function context(ctx)
  local session_id = ctx.session_id or rex.session_id
  local block_id = ctx.block_id or rex.block_id

  return session_id, block_id
end

-- Opens a floating pane in the caller's tab that runs `script` with sh, for a picker. `args` are
-- the script's $1, $2, and so on.
local function float_script(ctx, label, cwd, script, args)
  local session_id, block_id = context(ctx)
  local window = window_of_block(viewer()(session_id), block_id)
  local command = { "sh", "-c", script, label }

  for _, arg in ipairs(args) do
    command[#command + 1] = arg
  end

  in_session("session.new_layer", {
    session_id = session_id,
    window_id = window and window.window_id,
    bounds = { 0.15, 0.15, 0.7, 0.6 },
    focus = true,
    layout = { block = { flavor = SHELL, label = label, options = { cwd = cwd, command = command } } },
  })
end

-- The path of the file that calls this, so a picker can run it as a script. A script's source is
-- its path, which Lua would start with `@`. A file loaded by name gets the configuration's copy.
local function source_path(name)
  local source = (debug.getinfo(2, "S").source:gsub("^@", ""))

  if source:sub(1, 1) == "/" then
    return source
  end

  return (os.getenv("XDG_CONFIG_HOME") or (HOME .. "/.config")) .. "/rex/" .. name
end

return {
  TERMINAL = TERMINAL,
  SHELL = SHELL,
  STATE_DIR = STATE_DIR,
  fail = fail,
  expand = expand,
  trim = trim,
  basename = basename,
  tildify = tildify,
  within = within,
  exec = exec,
  exists = exists,
  read_json = read_json,
  realpath = realpath,
  slug = slug,
  write_json = write_json,
  with_lock = with_lock,
  own_pid = own_pid,
  call = call,
  gone = gone,
  processes = processes,
  attach = attach,
  in_session = in_session,
  viewer = viewer,
  window_in = window_in,
  window_of_block = window_of_block,
  block_cwd = block_cwd,
  context = context,
  float_script = float_script,
  source_path = source_path,
}
