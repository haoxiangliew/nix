{
  pkgs,
  lib,
  config,
  osConfig,
  inputs,
  ...
}:

let
  skillOf =
    packages: name: path:
    lib.listToAttrs (
      map (p: lib.nameValuePair name (path p)) (lib.filter (p: (p.pname or "") == name) packages)
    );

  skills = lib.mkMerge [
    (skillOf config.home.packages "herdr" (p: "${p.src}/skills/herdr"))
    (skillOf config.home.packages "tuicr" (p: "${p.src}/skills/tuicr"))
    (skillOf config.programs.gh.extensions "gh-stack" (p: "${p.src}/skills/gh-stack"))
    {
      unslop = "${inputs.pstack}/pstack/skills/unslop";
      technical-writing = "${inputs.pstack}/pstack/skills/technical-writing";
    }
  ];

  hasCask = name: lib.any (cask: cask.name == name) (osConfig.homebrew.casks or [ ]);

  mutableConfig = import ./mutableConfig.nix { inherit config lib pkgs; };
in

{
  home = lib.mkMerge [
    {
      sessionVariables = {
        # https://code.claude.com/docs/en/memory#enable-or-disable-auto-memory
        CLAUDE_CODE_DISABLE_AUTO_MEMORY = true;
        # https://code.claude.com/docs/en/agent-teams
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = true;
        # https://opencode.ai/docs/cli/#experimental
        OPENCODE_EXPERIMENTAL_PLAN_MODE = true;
        OPENCODE_EXPERIMENTAL_CODE_MODE = true;
        OPENCODE_EXPERIMENTAL_LSP_TOOL = true;
        OPENCODE_EXPERIMENTAL_OXFMT = true;
        OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = true;
        OPENCODE_EXPERIMENTAL_WEBSOCKETS = true;
      };
      packages = with pkgs.llm-agents; [
        grok
        herdr
        tuicr
      ];
    }
    (mutableConfig.mutableJson {
      name = "mergeClaudeCodeSettings";
      file = "${config.programs.claude-code.configDir}/settings.json";
    })
    (mutableConfig.mutableToml {
      name = "mergeCodexSettings";
      file = ".codex/config.toml";
    })
    (mutableConfig.mutableJson {
      name = "mergeOpenCodeSettings";
      file = "${config.xdg.configHome}/opencode/opencode.json";
    })
  ];

  xdg.configFile."herdr/config.toml".source = (pkgs.formats.toml { }).generate "herdr-config.toml" {
    onboarding = false;
    theme.name = "dracula";
    worktrees.directory = "~/Developer/.herdr/worktrees";
    experimental.kitty_graphics = true;
    ui = {
      toast.delivery = "terminal";
      sound.enabled = false;
      show_agent_labels_on_pane_borders = true;
    };
    update = {
      version_check = false;
      manifest_check = true;
    };
  };

  programs = {
    mcp = {
      enable = true;
      servers = {
        posthog = {
          url = "https://mcp.posthog.com/mcp";
          enabled = false;
        };
      }
      // lib.optionalAttrs (pkgs.stdenv.hostPlatform.isDarwin && hasCask "tableplus") {
        tableplus = {
          command = "/Applications/TablePlus.app/Contents/MacOS/tableplus-mcp";
          enabled = false;
        };
      };
    };
    claude-code = {
      enable = true;
      # generates a hm plugin containing `.mcp.json` and wraps claude w/ `--plugin-dir`
      enableMcpIntegration = true;
      package = pkgs.llm-agents.claude-code;
      settings = {
        theme = "auto";
        tui = "fullscreen";
        permissions.defaultMode = "auto";
        outputStyle = "Concise";
        showThinkingSummaries = true;
        promptSuggestionEnabled = true;
        attribution = {
          commit = "";
          pr = "";
          sessionUrl = false;
        };
      };
      inherit skills;
    };
    codex = {
      enable = true;
      enableMcpIntegration = true;
      package = pkgs.llm-agents.codex;
      settings = {
        approvals_reviewer = "auto_review";
        model_context_window = 1000000;
        model_auto_compact_token_limit = 900000;
        tui = {
          status_line = [
            "model-with-reasoning"
            "current-dir"
            "context-window-size"
            "used-tokens"
            "context-used"
            "fast-mode"
            "pull-request-number"
          ];
          status_line_use_colors = true;
        };
      };
      inherit skills;
    };
    opencode = {
      enable = true;
      enableMcpIntegration = true;
      package = pkgs.llm-agents.opencode;
      settings = {
        provider.openai.models = {
          "gpt-6-astra".limit = {
            context = 1050000;
            input = 922000;
            output = 128000;
          };
          "gpt-6-astra-fast".limit = {
            context = 1050000;
            input = 922000;
            output = 128000;
          };
        };
      };
      agents = {
        talk = ''
          ---
          description: Read-only agent for iterating on code with the user
          mode: primary
          permission:
            edit: deny
          ---

          You are a read-only agent designed to iterate on code together with the user. You inspect and reason about the codebase, but never modify, create, or delete files by any means, whether through file-editing tools or shell workarounds that write to disk. When proposing a change, write the complete updated code in your response so the user can review it, give feedback, and apply it themselves. Treat this as a back-and-forth: refine your suggestions based on their responses rather than trying to finalize edits yourself. Never claim to have edited a file, and never attempt to.
        '';
      };
      tui = {
        theme = "system";
        scroll_acceleration = {
          enabled = true;
        };
        attention = {
          enabled = true;
          sound = false;
        };
      };
      inherit skills;
    };
  };
}
