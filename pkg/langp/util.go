package langp

import (
	"log"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"time"

	"sourcegraph.com/sourcegraph/sourcegraph/pkg/cmdutil"
	"sourcegraph.com/sourcegraph/sourcegraph/pkg/conf/feature"
	"sourcegraph.com/sourcegraph/sourcegraph/pkg/lsp"
)

var btrfsPresent bool

func init() {
	if !feature.Features.Universe {
		return
	}
	_, err := exec.LookPath("btrfs")
	if err == nil {
		btrfsPresent = true
	} else {
		log.Println("btrfs command not available, assuming filesystem is not btrfs")
	}
}

func btrfsSubvolumeCreate(path string) error {
	if !btrfsPresent {
		return os.Mkdir(path, 0700)
	}
	return CmdRun(exec.Command("btrfs", "subvolume", "create", path))
}

func btrfsSubvolumeSnapshot(subvolumePath, snapshotPath string) error {
	if !btrfsPresent {
		// TODO: This isn't portable outside *nix, but it does spare us a lot
		// of complex logic. Maybe find a good package to copy a directory.
		return CmdRun(exec.Command("cp", "-r", subvolumePath, snapshotPath))
	}
	return CmdRun(exec.Command("btrfs", "subvolume", "snapshot", subvolumePath, snapshotPath))
}

// dirExists tells if the directory p exists or not.
func dirExists(p string) (bool, error) {
	info, err := os.Stat(p)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return info.IsDir(), nil
}

func lspKindToSymbol(kind lsp.SymbolKind) string {
	switch kind {
	case lsp.SKPackage:
		return "package"
	case lsp.SKField:
		return "field"
	case lsp.SKFunction:
		return "func"
	case lsp.SKMethod:
		return "method"
	case lsp.SKVariable:
		return "var"
	case lsp.SKClass:
		return "type"
	case lsp.SKInterface:
		return "interface"
	case lsp.SKConstant:
		return "const"
	default:
		// TODO(keegancsmith) We haven't implemented all types yet,
		// just what Go uses
		return "unknown"
	}
}

// ExpandSGPath expands the $SGPATH variable in the given string, except it
// uses ~/.sourcegraph as the default if $SGPATH is not set.
func ExpandSGPath(s string) (string, error) {
	sgpath := os.Getenv("SGPATH")
	if sgpath == "" {
		u, err := user.Current()
		if err != nil {
			return "", err
		}
		sgpath = filepath.Join(u.HomeDir, ".sourcegraph")
	}
	return strings.Replace(s, "$SGPATH", sgpath, -1), nil
}

// ResolveRepoAlias returns import path and clone URI of given repository URI,
// it takes special care to sourcegraph main repository.
func ResolveRepoAlias(repo string) (importPath, cloneURI string) {
	// TODO(slimsag): find a way to pass this information from the app instead
	// of hard-coding it here.
	if repo == "sourcegraph/sourcegraph" {
		return "sourcegraph.com/sourcegraph/sourcegraph", "git@github.com:sourcegraph/sourcegraph"
	}
	return repo, "https://" + repo
}

// UnresolveRepoAlias performs the opposite action of ResolveRepoAlias.
func UnresolveRepoAlias(repo string) string {
	if repo == "sourcegraph.com/sourcegraph/sourcegraph" {
		repo = "sourcegraph/sourcegraph"
	}
	return repo
}

// CmdOutput is a helper around c.Output which logs the command, how long it
// took to run, and a nice error in the event of failure.
func CmdOutput(c *exec.Cmd) ([]byte, error) {
	start := time.Now()
	stdout, err := cmdutil.Output(c)
	log.Printf("TIME: %v '%s'\n", time.Since(start), strings.Join(c.Args, " "))
	if err != nil {
		log.Println(err)
		return nil, err
	}
	return stdout, nil
}

// CmdRun is a helper around c.Run which logs the command, how long it took to
// run, and a nice error in the event of failure.
func CmdRun(c *exec.Cmd) error {
	start := time.Now()
	err := cmdutil.Run(c)
	log.Printf("TIME: %v '%s'\n", time.Since(start), strings.Join(c.Args, " "))
	if err != nil {
		log.Println(err)
		return err
	}
	return nil
}

// Clone clones the specified repository at the given commit into the specified
// directory. If update is true, this function assumes the git repository
// already exists and can just be fetched / updated.
func Clone(update bool, cloneURI, repoDir, commit string) error {
	if !update {
		err := CmdRun(exec.Command("git", "clone", cloneURI, repoDir))
		if err != nil {
			return err
		}
	} else {
		// Update our repo to match the remote.
		cmd := exec.Command("git", "remote", "update", "--prune")
		cmd.Dir = repoDir
		if err := CmdRun(cmd); err != nil {
			return err
		}
	}

	// Reset to the specific revision.
	cmd := exec.Command("git", "reset", "--hard", commit)
	cmd.Dir = repoDir
	return CmdRun(cmd)
}
