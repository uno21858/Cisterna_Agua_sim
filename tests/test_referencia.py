"""web/test/ref_py.json al día con gen_ref.py y con config.py (lo que el motor JS compara contra Python)."""

import dataclasses
import importlib.util
import json
from pathlib import Path

import pytest

from cisterna_sim.config import Config

RAIZ = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("gen_ref", RAIZ / "web" / "test" / "gen_ref.py")
gen_ref = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gen_ref)
REF = json.loads((RAIZ / "web" / "test" / "ref_py.json").read_text())


def _json(x):
    return json.loads(json.dumps(x))


def test_ref_generado_con_las_listas_y_los_defaults_actuales():
    assert REF["invalidos"] == _json(gen_ref.INVALIDOS)
    assert REF["validos"] == _json(gen_ref.VALIDOS)
    assert {n: c["cfg"] for n, c in REF["casos"].items()} == _json({n: c["cfg"] for n, c in gen_ref.CASOS.items()})
    defaults = {f.name: list(f.default) if isinstance(f.default, tuple) else f.default
                for f in dataclasses.fields(Config)}
    assert REF["defaults"] == _json(defaults), "corre python3 web/test/gen_ref.py"


@pytest.mark.parametrize("kw", gen_ref.INVALIDOS)
def test_invalidos(kw):
    with pytest.raises(ValueError):
        gen_ref._cfg(kw).validar()


@pytest.mark.parametrize("kw", gen_ref.VALIDOS)
def test_validos(kw):
    gen_ref._cfg(kw).validar()
