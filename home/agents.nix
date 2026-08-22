{ pkgs, inputs, ... }:

{
  home = {
    sessionVariables = {
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
    };
    claude-code = {
      enable = true;
      enableMcpIntegration = true;
      package = pkgs.llm-agents.claude-code;
      skills = {
        herdr = pkgs.runCommandLocal "herdr-skill" { } "${pkgs.llm-agents.herdr}/bin/herdr --skill > $out";
        tuicr = "${pkgs.llm-agents.tuicr.src}/skills/tuicr";
        unslop = "${inputs.pstack}/pstack/skills/unslop";
        technical-writing = "${inputs.pstack}/pstack/skills/technical-writing";
      };
    };
    codex = {
      enable = true;
      enableMcpIntegration = true;
      package = pkgs.llm-agents.codex;
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
      skills = {
        herdr = pkgs.runCommandLocal "herdr-skill" { } "${pkgs.llm-agents.herdr}/bin/herdr --skill > $out";
        tuicr = "${pkgs.llm-agents.tuicr.src}/skills/tuicr";
        unslop = "${inputs.pstack}/pstack/skills/unslop";
        technical-writing = "${inputs.pstack}/pstack/skills/technical-writing";
      };
    };
  };
}
