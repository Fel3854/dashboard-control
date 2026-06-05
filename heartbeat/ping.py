#!/usr/bin/env python3
"""
heartbeat/ping.py — reporta la "ultima corrida" de un proceso batch/local al dashboard.

Pensado para llamarse al FINAL de la corrida de Rotacion (Streamlit) u otro batch.
Actualiza heartbeats/<slug>.json en el repo via la GitHub Contents API (sin clonar el
repo). El checker lee ese archivo y, si pasan mas de `max_silencio_horas` sin novedad,
marca el proyecto como CAIDO.

Uso:
    GH_TOKEN=<token>  python3 heartbeat/ping.py --slug rotacion --ok
    GH_TOKEN=<token>  python3 heartbeat/ping.py --slug rotacion --fail   # corrida con error

Desde Python (al final de tu proceso):
    import subprocess, os
    subprocess.run(["python3", "heartbeat/ping.py", "--slug", "rotacion", "--ok"],
                   env={**os.environ, "GH_TOKEN": MI_TOKEN})

Requisitos:
  - Variable de entorno GH_TOKEN: un Personal Access Token (fine-grained recomendado)
    con permiso *Contents: Read and write* SOLO sobre el repo del dashboard.
  - Repo y rama configurables por flags/env (defaults abajo). NO se commitea ningun token.

Solo usa la libreria estandar (urllib): no instala nada.
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

REPO_DEFAULT = "Fel3854/dashboard-control"
BRANCH_DEFAULT = "main"
API = "https://api.github.com"


def _req(method, url, token, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read() or "{}")


def main():
    ap = argparse.ArgumentParser(description="Reporta el heartbeat de un proceso al dashboard.")
    ap.add_argument("--slug", required=True, help="identificador del proyecto, ej. rotacion")
    ap.add_argument("--repo", default=os.environ.get("HEARTBEAT_REPO", REPO_DEFAULT))
    ap.add_argument("--branch", default=os.environ.get("HEARTBEAT_BRANCH", BRANCH_DEFAULT))
    grupo = ap.add_mutually_exclusive_group()
    grupo.add_argument("--ok", action="store_true", help="la corrida termino bien (default)")
    grupo.add_argument("--fail", action="store_true", help="la corrida termino con error")
    args = ap.parse_args()

    token = os.environ.get("GH_TOKEN")
    if not token:
        sys.exit("ERROR: falta la variable de entorno GH_TOKEN (PAT con Contents: write).")

    ruta = f"heartbeats/{args.slug}.json"
    url = f"{API}/repos/{args.repo}/contents/{ruta}"

    contenido = {
        "ultima_corrida": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "ok": not args.fail,
    }
    nuevo_b64 = base64.b64encode(json.dumps(contenido, indent=2).encode()).decode()

    # La Contents API exige el `sha` del archivo si ya existe: lo buscamos primero.
    sha = None
    try:
        actual = _req("GET", f"{url}?ref={args.branch}", token)
        sha = actual.get("sha")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise

    payload = {
        "message": f"heartbeat: {args.slug} {'OK' if not args.fail else 'FAIL'} [skip ci]",
        "content": nuevo_b64,
        "branch": args.branch,
    }
    if sha:
        payload["sha"] = sha

    _req("PUT", url, token, payload)
    print(f"heartbeat reportado: {ruta} -> {contenido['ultima_corrida']} (ok={contenido['ok']})")


if __name__ == "__main__":
    main()
