// patient.js — Patient self-service portal (uses existing patient APIs)

const API_BASE_URL = "https://hms-production-a5ad.up.railway.app";

function getToken() {
    return localStorage.getItem("clinicProToken");
}

function authHeaders() {
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getToken()}`,
    };
}

function showAlert(message, type = "danger") {
    const el = document.getElementById("alert");
    el.className = `alert alert-${type}`;
    el.textContent = message;
    el.classList.remove("d-none");
}

function hideAlert() {
    document.getElementById("alert").classList.add("d-none");
}

async function api(path, options = {}) {
    const response = await fetch(`${API_BASE_URL}${path}`, {
        ...options,
        headers: { ...authHeaders(), ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.message || `Request failed (${response.status})`);
    }
    return data;
}

async function loadDoctors() {
    const doctors = await api("/api/patient/doctors");
    const select = document.getElementById("doctor-select");
    select.innerHTML = doctors
        .map(
            (d) =>
                `<option value="${d.doctor_id}" data-branch="${d.branch_id || ""}">${d.name}${
                    d.specialty ? ` — ${d.specialty}` : ""
                }</option>`
        )
        .join("");
}

async function loadSlots() {
    hideAlert();
    const doctorId = document.getElementById("doctor-select").value;
    const date = document.getElementById("date-input").value;
    const slotSelect = document.getElementById("slot-select");

    if (!doctorId || !date) {
        slotSelect.innerHTML = `<option value="">Select doctor and date</option>`;
        return;
    }

    slotSelect.innerHTML = `<option value="">Loading…</option>`;
    try {
        const slots = await api(`/api/doctors/${doctorId}/availability?date=${encodeURIComponent(date)}`);
        if (!slots.length) {
            slotSelect.innerHTML = `<option value="">No free slots</option>`;
            return;
        }
        slotSelect.innerHTML = slots.map((s) => `<option value="${s}">${s}</option>`).join("");
    } catch (err) {
        slotSelect.innerHTML = `<option value="">Failed to load</option>`;
        showAlert(err.message);
    }
}

async function loadAppointments() {
    const body = document.getElementById("appointments-body");
    try {
        const rows = await api("/api/patient/my-appointments");
        if (!rows.length) {
            body.innerHTML = `<tr><td colspan="4" class="text-muted">No appointments yet.</td></tr>`;
            return;
        }
        body.innerHTML = rows
            .map(
                (r) => `<tr>
                <td>${r.schedule_date || r.when || ""}</td>
                <td>${r.doctor_name || r.doctor || "—"}</td>
                <td>${r.branch_name || r.branch || "—"}</td>
                <td><span class="badge text-bg-secondary">${r.status || ""}</span></td>
            </tr>`
            )
            .join("");
    } catch (err) {
        body.innerHTML = `<tr><td colspan="4" class="text-danger">${err.message}</td></tr>`;
    }
}

async function loadDocuments() {
    const list = document.getElementById("documents-list");
    try {
        const docs = await api("/api/patient/my-documents");
        if (!docs.length) {
            list.innerHTML = `<div class="text-muted">No documents yet.</div>`;
            return;
        }
        list.innerHTML = docs
            .map((d) => {
                return `<div class="list-group-item px-0">
                    <div class="fw-semibold">${d.type || "Document"}</div>
                    <div class="small text-muted">${d.date || ""}</div>
                    <div class="small">${d.details || "—"}</div>
                </div>`;
            })
            .join("");
    } catch (err) {
        list.innerHTML = `<div class="text-danger">${err.message}</div>`;
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    if (!getToken()) {
        window.location.href = "index.html";
        return;
    }

    document.getElementById("logout-btn").addEventListener("click", () => {
        localStorage.removeItem("clinicProToken");
        window.location.href = "index.html";
    });

    document.getElementById("load-slots-btn").addEventListener("click", loadSlots);
    document.getElementById("date-input").addEventListener("change", loadSlots);
    document.getElementById("doctor-select").addEventListener("change", loadSlots);
    document.getElementById("refresh-appts-btn").addEventListener("click", loadAppointments);
    document.getElementById("refresh-docs-btn").addEventListener("click", loadDocuments);

    document.getElementById("book-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        hideAlert();
        const doctorId = document.getElementById("doctor-select").value;
        const date = document.getElementById("date-input").value;
        const time = document.getElementById("slot-select").value;
        const branchId = document.getElementById("doctor-select").selectedOptions[0]?.dataset.branch;

        try {
            await api("/api/patient/book-appointment", {
                method: "POST",
                body: JSON.stringify({
                    doctorId: Number(doctorId),
                    branchId: Number(branchId),
                    scheduleDateTime: `${date} ${time}:00`,
                }),
            });
            showAlert("Appointment booked successfully.", "success");
            await loadSlots();
            await loadAppointments();
        } catch (err) {
            showAlert(err.message);
        }
    });

    try {
        await loadDoctors();
        await loadAppointments();
        await loadDocuments();
    } catch (err) {
        showAlert(err.message + " — try logging in again as a patient.");
    }
});
