{ pkgs, ... }:

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
    ];
  };

  programs = {
    mcp = {
      enable = true;
    };
    claude-code = {
      enable = true;
      enableMcpIntegration = true;
      package = pkgs.llm-agents.claude-code;
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
    };
  };
}
