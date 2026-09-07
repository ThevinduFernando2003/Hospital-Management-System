// login.js

const API_BASE_URL = "https://hms-production-a5ad.up.railway.app";

document.addEventListener("DOMContentLoaded", () => {
    const loginForm = document.getElementById("login-form");
    const usernameInput = document.getElementById("username");
    const passwordInput = document.getElementById("password");
    const errorMessage = document.getElementById("error-message");
    const patientHint = document.getElementById("patient-hint");
    const usernameLabel = document.getElementById("username-label");
    const passwordLabel = document.getElementById("password-label");

    function isPatientLogin() {
        const checked = document.querySelector('input[name="login-type"]:checked');
        return checked && checked.value === "patient";
    }

    function refreshLoginMode() {
        const patient = isPatientLogin();
        usernameLabel.textContent = patient ? "First name" : "Username";
        passwordLabel.textContent = "Password";
        patientHint.classList.toggle("d-none", !patient);
    }

    document.querySelectorAll('input[name="login-type"]').forEach((el) => {
        el.addEventListener("change", refreshLoginMode);
    });
    refreshLoginMode();

    loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        errorMessage.classList.add("d-none");

        const username = usernameInput.value;
        const password = passwordInput.value;
        const endpoint = isPatientLogin() ? "/api/login/patient" : "/api/login";

        try {
            const response = await fetch(`${API_BASE_URL}${endpoint}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password }),
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || "An unknown error occurred.");
            }

            const { token, role } = data;
            localStorage.setItem("clinicProToken", token);

            switch (role) {
                case "admin":
                    window.location.href = "admin.html";
                    break;
                case "receptionist":
                    window.location.href = "reception.html";
                    break;
                case "branch manager":
                    window.location.href = "branch.html";
                    break;
                case "doctor":
                    window.location.href = "doctor-portal.html";
                    break;
                case "patient":
                    window.location.href = "patient.html";
                    break;
                default:
                    errorMessage.textContent = "Your user role does not have a dashboard.";
                    errorMessage.classList.remove("d-none");
            }
        } catch (error) {
            errorMessage.textContent = error.message;
            errorMessage.classList.remove("d-none");
        }
    });
});
