"""Read-only, point-in-time verification of the planning document migration."""

import hashlib
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "docs/reviews/post-phase10-planning-migration.json"


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def main():
    manifest = json.loads(MANIFEST.read_text())
    reconstructed = [manifest["sourcePrefix"]]
    checked_links = 0
    assert [item["sourceSection"] for item in manifest["sections"]] == list(range(1, 16))
    for item in manifest["sections"]:
        path = ROOT / item["destination"]
        document = path.read_text()
        assert document.count(item["begin"]) == 1, item["sourceSection"]
        assert document.count(item["end"]) == 1, item["sourceSection"]
        chunk = document.split(item["begin"])[1].split(item["end"])[0]
        assert digest(chunk) == item["migratedSha256"], item["sourceSection"]
        restored = chunk
        for operation in reversed(item["changes"]):
            restored = restored.replace(operation["new"], operation["old"])
        assert digest(restored) == item["sourceSha256"], item["sourceSection"]
        reconstructed.append(restored)
        for link in re.findall(r"\]\(([^)]+)\)", chunk):
            if "://" in link:
                continue
            filename, _, anchor = link.partition("#")
            target = path.parent / filename if filename else path
            assert target.exists(), (item["sourceSection"], link)
            if anchor.startswith("future-"):
                assert f'id="{anchor}"' in target.read_text(), link
            checked_links += 1
    text = "".join(reconstructed)
    assert digest(text) == manifest["sourceSha256"]
    assert len(text.encode()) == manifest["sourceBytes"]
    print(
        f"PASS: 15 sections and {manifest['sourceBytes']} source bytes reconstructed; "
        f"{checked_links} local links checked. Original draft was not read."
    )


if __name__ == "__main__":
    main()
