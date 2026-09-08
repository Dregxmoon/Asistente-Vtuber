#!/usr/bin/env python3
"""Puente JSON mínimo para AT-SPI2. No interpreta comandos del usuario."""

import json
import os
import sys
import time


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False))


def fail(message):
    emit({"ok": False, "error": str(message)[:500]})
    raise SystemExit(0)


try:
    request = json.loads(sys.stdin.read() or "{}")
except Exception:
    fail("Solicitud JSON inválida")

BACKEND = "pyatspi"
try:
    import pyatspi
    Atspi = None
except Exception:
    try:
        import gi

        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi, Gio, GLib

        pyatspi = None
        BACKEND = "gi-atspi2"
    except Exception:
        fail("AT-SPI2 no está disponible; instala python-gobject/at-spi2-core o python3-pyatspi")


def ensure_accessibility_bus():
    if BACKEND != "gi-atspi2":
        return
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        response = bus.call_sync(
            "org.a11y.Bus",
            "/org/a11y/bus",
            "org.a11y.Bus",
            "GetAddress",
            None,
            GLib.VariantType.new("(s)"),
            Gio.DBusCallFlags.NONE,
            3000,
            None,
        )
        address = response.unpack()[0]
        if address:
            os.environ["AT_SPI_BUS_ADDRESS"] = address
    except Exception:
        fail("No se pudo activar el bus de accesibilidad AT-SPI2 en esta sesión")


def safe(callable_value, default=None):
    try:
        return callable_value()
    except Exception:
        return default


def role_name(node):
    if BACKEND == "pyatspi":
        return str(safe(lambda: node.getRoleName(), "unknown") or "unknown")[:80]
    return str(safe(lambda: node.get_role_name(), "unknown") or "unknown")[:80]


def node_name(node):
    if BACKEND == "pyatspi":
        return str(safe(lambda: node.name, "") or "")[:300]
    return str(safe(lambda: node.get_name(), "") or "")[:300]


def process_id(node):
    return int(safe(lambda: node.get_process_id(), 0) or 0)


def states(node):
    state_set = safe(
        lambda: node.getState() if BACKEND == "pyatspi" else node.get_state_set(), None
    )
    if not state_set:
        return []
    names = []
    for state in (
        "STATE_ACTIVE",
        "STATE_BUSY",
        "STATE_CHECKED",
        "STATE_EDITABLE",
        "STATE_ENABLED",
        "STATE_EXPANDED",
        "STATE_FOCUSED",
        "STATE_SELECTED",
        "STATE_SHOWING",
        "STATE_VISIBLE",
    ):
        if BACKEND == "pyatspi":
            state_value = getattr(pyatspi, state, None)
        else:
            state_value = getattr(Atspi.StateType, state.replace("STATE_", ""), None)
        if state_value is not None and safe(lambda: state_set.contains(state_value), False):
            names.append(state.replace("STATE_", "").lower())
    return names


def bounds(node):
    component = safe(
        lambda: node.queryComponent() if BACKEND == "pyatspi" else node.get_component(), None
    )
    if not component:
        return None
    rect = safe(
        lambda: component.getExtents(pyatspi.DESKTOP_COORDS)
        if BACKEND == "pyatspi"
        else component.get_extents(Atspi.CoordType.SCREEN),
        None,
    )
    if not rect:
        return None
    return {"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height}


def children(node):
    count = min(
        int(
            safe(
                lambda: node.childCount
                if BACKEND == "pyatspi"
                else node.get_child_count(),
                0,
            )
            or 0
        ),
        500,
    )
    result = []
    for index in range(count):
        child = safe(
            lambda idx=index: node.getChildAtIndex(idx)
            if BACKEND == "pyatspi"
            else node.get_child_at_index(idx),
            None,
        )
        if child is not None:
            result.append((index, child))
    return result


def snapshot():
    application_filter = str(request.get("application") or "").casefold()
    max_depth = max(1, min(int(request.get("maxDepth") or 6), 12))
    max_nodes = max(10, min(int(request.get("maxNodes") or 250), 1000))
    desktop = pyatspi.Registry.getDesktop(0) if BACKEND == "pyatspi" else Atspi.get_desktop(0)
    nodes = []

    def visit(node, path, depth, app_name, app_pid, window_name):
        if len(nodes) >= max_nodes or depth > max_depth:
            return
        name = node_name(node)
        role = role_name(node)
        current_window = window_name
        if depth <= 1 and role in ("frame", "window", "dialog"):
            current_window = name
        entry = {
            "path": path,
            "application": app_name,
            "processId": app_pid,
            "window": current_window,
            "name": name,
            "role": role,
            "states": states(node),
            "bounds": bounds(node),
            "depth": depth,
        }
        nodes.append(entry)
        for index, child in children(node):
            visit(child, path + "/" + str(index), depth + 1, app_name, app_pid, current_window)

    for app_index, app in children(desktop):
        app_name = node_name(app)
        if application_filter and application_filter not in app_name.casefold():
            continue
        pid = process_id(app)
        for child_index, child in children(app):
            visit(child, str(app_index) + "/" + str(child_index), 0, app_name, pid, node_name(child))
            if len(nodes) >= max_nodes:
                break
    return {
        "ok": True,
        "platform": "linux",
        "backend": BACKEND,
        "nodes": nodes,
        "truncated": len(nodes) >= max_nodes,
    }


def matches(node, target):
    target_pid = int(target.get("processId") or 0)
    if target_pid and process_id(node) != target_pid:
        return False
    target_name = str(target.get("name") or "")
    target_role = str(target.get("role") or "")
    return (not target_name or node_name(node) == target_name) and (
        not target_role or role_name(node) == target_role
    )


def resolve_target(target):
    desktop = pyatspi.Registry.getDesktop(0) if BACKEND == "pyatspi" else Atspi.get_desktop(0)
    path_parts = []
    try:
        path_parts = [int(part) for part in str(target.get("path") or "").split("/") if part != ""]
    except Exception:
        path_parts = []
    node = desktop
    for index in path_parts:
        node = safe(
            lambda idx=index, current=node: current.getChildAtIndex(idx)
            if BACKEND == "pyatspi"
            else current.get_child_at_index(idx),
            None,
        )
        if node is None:
            break
    if node is not None and matches(node, target):
        return node

    queue = [desktop]
    visited = 0
    while queue and visited < 5000:
        candidate = queue.pop(0)
        visited += 1
        if candidate is not desktop and matches(candidate, target):
            return candidate
        queue.extend(child for _, child in children(candidate))
    return None


def execute():
    action = str(request.get("action") or "")
    target = request.get("target") or {}
    action_input = request.get("input") or {}
    if action == "pointer_click":
        x = int(action_input.get("x") or 0)
        y = int(action_input.get("y") or 0)
        if BACKEND == "pyatspi":
            pyatspi.Registry.generateMouseEvent(x, y, "b1c")
        else:
            Atspi.generate_mouse_event(x, y, "b1c")
        return {"ok": True, "executed": True, "evidence": {"x": x, "y": y}}
    node = resolve_target(target)
    if node is None:
        return {"ok": False, "error": "El elemento cambió o ya no existe", "stale": True}

    if action == "focus":
        component = safe(
            lambda: node.queryComponent() if BACKEND == "pyatspi" else node.get_component(), None
        )
        focused = safe(
            lambda: component.grabFocus()
            if BACKEND == "pyatspi"
            else component.grab_focus(),
            False,
        )
        if not component or not focused:
            return {"ok": False, "error": "El elemento no acepta foco"}
    elif action in ("click", "select", "close"):
        action_iface = safe(
            lambda: node.queryAction() if BACKEND == "pyatspi" else node.get_action(), None
        )
        if not action_iface:
            return {"ok": False, "error": "El elemento no expone acciones accesibles"}
        preferred = {
            "click": ("click", "press", "activate"),
            "select": ("select", "activate", "click"),
            "close": ("close", "dismiss"),
        }[action]
        selected_index = -1
        action_count = int(
            action_iface.nActions if BACKEND == "pyatspi" else action_iface.get_n_actions()
        )
        for index in range(action_count):
            name = str(
                safe(
                    lambda idx=index: action_iface.getName(idx)
                    if BACKEND == "pyatspi"
                    else action_iface.get_action_name(idx),
                    "",
                )
                or ""
            ).casefold()
            if any(candidate in name for candidate in preferred):
                selected_index = index
                break
        if selected_index < 0:
            return {"ok": False, "error": "La acción accesible no está disponible"}
        invoked = safe(
            lambda: action_iface.doAction(selected_index)
            if BACKEND == "pyatspi"
            else action_iface.do_action(selected_index),
            False,
        )
        if not invoked:
            return {"ok": False, "error": "La acción accesible fue rechazada"}
    elif action == "type":
        value = str(action_input.get("value") or "")
        editable = safe(
            lambda: node.queryEditableText()
            if BACKEND == "pyatspi"
            else node.get_editable_text(),
            None,
        )
        if not editable:
            return {"ok": False, "error": "El elemento no admite edición accesible"}
        if BACKEND == "pyatspi":
            editable.setTextContents(value)
        else:
            editable.set_text_contents(value)
    elif action == "press":
        key = str(action_input.get("key") or "")
        component = safe(
            lambda: node.queryComponent() if BACKEND == "pyatspi" else node.get_component(), None
        )
        if component:
            if BACKEND == "pyatspi":
                component.grabFocus()
            else:
                component.grab_focus()
        if BACKEND == "pyatspi":
            pyatspi.Registry.generateKeyboardEvent(0, key, pyatspi.KEY_STRING)
        else:
            Atspi.generate_keyboard_event(0, key, Atspi.KeySynthType.STRING)
    else:
        return {"ok": False, "error": "Acción AT-SPI2 desconocida"}

    time.sleep(0.15)
    evidence = {"name": node_name(node), "role": role_name(node), "states": states(node)}
    if action == "type":
        evidence["valueLength"] = len(str(action_input.get("value") or ""))
    return {
        "ok": True,
        "executed": True,
        "evidence": evidence,
    }


operation = str(request.get("operation") or "")
try:
    ensure_accessibility_bus()
    if operation == "health":
        if BACKEND == "pyatspi":
            pyatspi.Registry.getDesktop(0)
        else:
            Atspi.get_desktop_count()
        emit({"ok": True, "platform": "linux", "backend": BACKEND})
    elif operation == "snapshot":
        emit(snapshot())
    elif operation == "execute":
        emit(execute())
    else:
        fail("Operación desconocida")
except Exception as error:
    fail(error)
