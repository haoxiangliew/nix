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

  skills =
    skillOf config.home.packages "herdr" (
      p: pkgs.runCommandLocal "herdr-skill" { } "${p}/bin/herdr --skill > $out"
    )
    // skillOf config.home.packages "tuicr" (p: "${p.src}/skills/tuicr")
    // skillOf config.programs.gh.extensions "gh-stack" (p: "${p.src}/skills/gh-stack")
    // {
      unslop = "${inputs.pstack}/pstack/skills/unslop";
      technical-writing = "${inputs.pstack}/pstack/skills/technical-writing";
    };

  hasCask = name: lib.any (cask: cask.name == name) (osConfig.homebrew.casks or [ ]);
in

{
  home = {
    sessionVariables = {
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
  };

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
      enableMcpIntegration = true;
      package = pkgs.llm-agents.claude-code;
      inherit skills;
    };
    codex = {
      enable = true;
      enableMcpIntegration = false; # mcpConfig for codex locks away settings
      package = pkgs.llm-agents.codex;
      inherit skills;
    };
    opencode = {
      enable = true;
      enableMcpIntegration = true;
      package = pkgs.llm-agents.opencode;
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
