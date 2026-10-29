-- The state file that maps each worktree tab to its worktree, which worktree.lua writes. pi's
-- rex_agents reads it too, to show which tabs are worktree tabs.

local shared = require("lib.shared")

local fail, tildify, read_json = shared.fail, shared.tildify, shared.read_json
local write_json, with_lock = shared.write_json, shared.with_lock
local window_in = shared.window_in

local STATE = shared.STATE_DIR .. "/worktrees.json"

-- How long a call waits for another to finish with the state file, checking every 50 ms.
local STATE_WAIT = { seconds = 10, poll = 0.05 }

local function load_state()
  local state = read_json(STATE) or { windows = {} }

  if type(state.windows) ~= "table" then
    fail(("%s has no `windows` object. Fix or delete it."):format(tildify(STATE)))
  end

  return state
end


-- Runs fn(state) while no other call can change the state file, and saves the state when fn
-- returns true as its second value.
local function with_state(fn)
  return with_lock(STATE .. ".lock", STATE_WAIT, function()
    local state = load_state()
    local value, changed = fn(state)

    if changed then
      write_json(STATE, state)
    end

    return value
  end)
end

-- The open tabs of each worktree path. Windows that closed leave the state, and the second value
-- says whether any did.
local function open_tabs(state, view)
  local tabs, pruned = {}, false

  for window_id, entry in pairs(state.windows) do
    local window = window_in(view(entry.session_id), window_id)

    if window == nil then
      state.windows[window_id] = nil
      pruned = true
    else
      tabs[entry.path] = tabs[entry.path] or {}
      table.insert(tabs[entry.path], {
        session_id = entry.session_id,
        window_id = window_id,
        label = window.label,
        focused_block_id = window.focused_block_id,
      })
    end
  end

  return tabs, pruned
end

return { load_state = load_state, with_state = with_state, open_tabs = open_tabs }
