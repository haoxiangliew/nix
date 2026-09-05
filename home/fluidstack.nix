{ ... }:

{
  programs.helix.languages = {
    language = [
      {
        name = "python";
        auto-format = true;
      }
      {
        name = "typescript";
        language-servers = [ "vtsls" ];
      }
      {
        name = "tsx";
        language-servers = [ "vtsls" ];
      }
      {
        name = "javascript";
        language-servers = [ "vtsls" ];
      }
      {
        name = "jsx";
        language-servers = [ "vtsls" ];
      }
      {
        name = "protobuf";
        auto-format = true;
      }
      {
        name = "yaml";
        auto-format = false;
      }
    ];

    language-server = {
      yaml-language-server.config.yaml.schemas = {
        "https://json.schemastore.org/github-workflow.json" = ".github/workflows/*.{yml,yaml}";
        "https://json.schemastore.org/github-action.json" = ".github/actions/*/action.{yml,yaml}";
        "https://moonrepo.dev/schemas/project.json" = "moon.{yml,yaml}";
        "https://moonrepo.dev/schemas/tasks.json" = ".moon/tasks/*.{yml,yaml}";
      };
    };
  };

  xdg.configFile."fish/completions/moon.fish".text = ''
    if command -q moon
        moon completions --shell fish | source

        function __moon_targets
            moon query tasks 2>/dev/null | jq -r '.tasks[][].target'
        end

        function __moon_projects
            moon query projects 2>/dev/null | jq -r '.projects[].id'
        end

        for cmd in action-graph ci exec run task task-graph
            complete -c moon -n "__fish_moon_using_subcommand $cmd" -f -a "(__moon_targets)"
        end

        for cmd in check project project-graph tasks
            complete -c moon -n "__fish_moon_using_subcommand $cmd" -f -a "(__moon_projects)"
        end
    end
  '';
}
