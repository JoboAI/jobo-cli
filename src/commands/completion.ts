import { choice, type CommandDef, type Ctx } from "../args";
import { COMPLETE_COMMAND, FILES } from "../complete";
import { UsageError } from "../errors";

/**
 * The completion scripts. Each is a thin, static adapter: it hands the words
 * typed so far to `jobo __complete` and offers the lines that come back, so
 * a new command, flag or value needs no new script. `__files__` alone means
 * "a file name goes here", which the shell completes itself.
 *
 * Candidates are data (a company's domain, a skill's name): no script passes
 * them through `eval` or a word-splitting expansion.
 */
const BASH = `# bash completion for jobo.
# Install: add this line to ~/.bashrc
#   eval "$(jobo completion bash)"
_jobo_complete() {
  local cur=\${COMP_WORDS[COMP_CWORD]} line i
  COMPREPLY=()
  while IFS= read -r line; do
    COMPREPLY+=("$line")
  done < <(jobo ${COMPLETE_COMMAND} -- "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)
  (( \${#COMPREPLY[@]} )) || return 0
  if [[ \${COMPREPLY[0]} == ${FILES} ]]; then
    COMPREPLY=()
    # bash 4+: hand the word to readline's own file completion. bash 3: list the files here.
    compopt -o default 2>/dev/null || { local IFS=$'\\n'; COMPREPLY=($(compgen -f -- "$cur")); }
    return 0
  fi
  # bash 3 passes --flag=value as one word, yet readline replaces only what
  # follows the "=": take the part it keeps off each candidate. (bash 4+ splits
  # the word itself, and jobo has then already done this.)
  local held=
  [[ $cur == *=* && $COMP_WORDBREAKS == *=* ]] && held=\${cur%"\${cur##*=}"}
  for i in "\${!COMPREPLY[@]}"; do
    line=\${COMPREPLY[$i]#"$held"}
    # A candidate is literal text. Escape one the shell would split or expand,
    # unless the word is already inside quotes (readline closes those itself).
    case $cur in
      \\"*|\\'*) ;;
      *) [[ $line == *[^[:alnum:]_@%+=:,./-]* ]] && printf -v line '%q' "$line" ;;
    esac
    COMPREPLY[$i]=$line
  done
}
complete -F _jobo_complete jobo
`;

const ZSH = `#compdef jobo
# zsh completion for jobo.
# Install: add this line to ~/.zshrc, after compinit
#   eval "$(jobo completion zsh)"
# or save it on your fpath:  jobo completion zsh > "\${fpath[1]}/_jobo"
_jobo() {
  local -a candidates
  candidates=("\${(@f)$(jobo ${COMPLETE_COMMAND} -- "\${(@Q)words[2,CURRENT]}" 2>/dev/null)}")
  if [[ \${candidates[1]} == ${FILES} ]]; then
    _files
  elif [[ -n \${candidates[1]} ]]; then
    # -U: jobo already matched these against the word, and each one replaces it whole.
    compadd -U -- "\${candidates[@]}"
  fi
}
if [[ \${funcstack[1]} == _jobo ]]; then
  _jobo "$@"
else
  compdef _jobo jobo
fi
`;

const FISH = `# fish completion for jobo.
# Install:  jobo completion fish > ~/.config/fish/completions/jobo.fish
function __jobo_complete
    set -l cur (commandline -ct)
    set -l out (jobo ${COMPLETE_COMMAND} -- (commandline -opc)[2..-1] "$cur" 2>/dev/null)
    if test (count $out) -eq 0
        return
    end
    if test "$out[1]" = ${FILES}
        __fish_complete_path "$cur"
    else
        printf '%s\\n' $out
    end
end
complete -c jobo -f -a '(__jobo_complete)'
`;

export const COMPLETION_SCRIPTS = { bash: BASH, zsh: ZSH, fish: FISH } as const;
const SHELLS = Object.keys(COMPLETION_SCRIPTS) as Array<keyof typeof COMPLETION_SCRIPTS>;

async function run(ctx: Ctx): Promise<number> {
  const given = ctx.positionals[0]?.trim();
  if (!given || ctx.positionals.length > 1) {
    throw new UsageError(`Usage: jobo completion <${SHELLS.join("|")}>. It prints the script; the help shows where to put it.`);
  }
  const shell = choice(given, SHELLS, "jobo completion") as keyof typeof COMPLETION_SCRIPTS;
  await ctx.io.stdout.write(COMPLETION_SCRIPTS[shell]);
  return 0;
}

export const completionCommand: CommandDef = {
  name: "completion",
  summary: "Print a shell completion script (bash, zsh or fish)",
  usage: ["<bash|zsh|fish>"],
  description:
    "Prints a completion script for your shell. TAB then completes commands, flags, fixed values (--work-model, --sort), facet names for `jobo filters` and client ids for `jobo mcp`, " +
    "and looks up live values with your saved key: ATS sources, industries and job categories (cached for ten minutes), skills, and companies (completed to their domain) and places as you type them. " +
    "Those lookups use free endpoints only, give up after 1.5 seconds and stay silent when there is no key or no network. In a comma-separated value, the last item is completed.\n\n" +
    "Install it once:\n" +
    '- bash: add `eval "$(jobo completion bash)"` to ~/.bashrc.\n' +
    '- zsh: add `eval "$(jobo completion zsh)"` to ~/.zshrc, after compinit.\n' +
    "- fish: run `jobo completion fish > ~/.config/fish/completions/jobo.fish`.\n\n" +
    "The script only calls back into jobo, so it does not need replacing when the CLI is updated.",
  args: [{ choices: SHELLS }],
  examples: [
    'eval "$(jobo completion bash)"',
    'eval "$(jobo completion zsh)"',
    "jobo completion fish > ~/.config/fish/completions/jobo.fish",
  ],
  run,
};
