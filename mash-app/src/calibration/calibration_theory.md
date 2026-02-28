# IMU Sensor-to-Bone Calibration & Orientation Theory

## The Core Challenge: Arbitrary Sensor Placement

In human motion capture, we cannot rely on the user to place sensors perfectly aligned with their bones. A sensor on the thigh might be rotated 45° sideways, tilted 10° forward, or even upside down. If we simply mapped the sensor's rotation directly to the virtual bone, the avatar would look broken.

**The Goal:** We need to mathematically "erase" the sensor's physical misalignment so that the **virtual segment** moves exactly like the **real anatomical bone**, regardless of how the sensor is taped to the skin.

---

## 1. The Coordinate Systems

To solve this, we must strictly define our coordinate frames. We use **Quaternions** for all rotations to guarantee **zero gimbal lock**.

1.  **Global Frame ($F_G$)**: The Earth reference (Gravity is Down). Setup by the IMU's 9-axis fusion.
2.  **Sensor Frame ($F_S$)**: The local coordinate system of the plastic casing of the IMU.
3.  **Bone Frame ($F_B$)**: The anatomical coordinate system of the bone (e.g., Y-axis is along the bone length, X-axis is the knee hinge).
4.  **Virtual/display Frame ($F_V$)**: The Three.js coordinate system (World Space).

---

## 2. The Math of Correction ($q_{mounting}$)

At any moment $t$, the sensor gives us its orientation in the global frame: $q_{sensor}(t)$.
We want the orientation of the bone: $q_{bone}(t)$.

These two related by a constant **Mounting Rotation** ($q_{mounting}$) that represents how the sensor is attached to the bone.

$$q_{bone}(t) = q_{sensor}(t) \otimes q_{mounting}$$

> **Note:** The order of multiplication matters! This is a "local" rotation, meaning the mounting offset is applied *relative to the sensor's current orientation*.

### Finding $q_{mounting}$ (Calibration)

We don't know $q_{mounting}$ initially. We find it through **Calibration**.

#### A. Static Calibration (T-Pose / N-Pose)
The user stands in a known pose (e.g., T-Pose). In this pose, we **know** what the bone orientation *should* be ($q_{target}$).

$$q_{target} = q_{sensor\_measured} \otimes q_{mounting}$$

We can solve for $q_{mounting}$ by multiplying both sides by the inverse (conjugate) of the measured sensor reading:

$$q_{mounting} = q_{sensor\_measured}^{-1} \otimes q_{target}$$

**Result:** Now, even if the sensor is upside down, applying this $q_{mounting}$ will rotate the virtual bone to the correct T-Pose.

#### B. Functional Calibration (The "Magic" Fix)
Static calibration has a flaw: it relies on the user standing *perfectly* straight. If their knees are slightly bent or the sensor is on a bulging muscle, the alignment might be off by 5-10°.

**Functional Calibration** fixes this by looking at **movement**, not just pose.

1.  **The Knee Hinge:** The knee is a hinge joint. It rotates primarily around one axis (the Medial-Lateral axis).
2.  **PCA Analysis:** When a user lifts their knee (marches), the sensor creates a swath of gyro data. We run **Principal Component Analysis (PCA)** on this gyro data.
    *   The **First Principal Component** is the *actual* rotation axis of the knee **as seen by the sensor**.
3.  **The Correction:** We calculate the rotation needed to align this *measured* hinge axis with the *theoretical* anatomical hinge axis (e.g., the virtual knee's X-axis).

This ensures that when the real user bends their knee, the virtual knee bends *exactly* along its hinge, preventing "cross-talk" where a knee bend looks like a weird twist.

---

## 3. Why Quaternions? (No Gimbal Lock)

Euler angles (Yaw, Pitch, Roll) suffer from **Gimbal Lock**: when two axes align (e.g., looking straight up), you lose a degree of freedom, causing the camera or limb to flip wildly.

**Quaternions ($w, x, y, z$)** represent orientation as a single rotation around a 3D vector.
*   They are **continuous**: No jumps or flips.
*   They interpolate smoothly (SLERP).
*   They handle "upside down" or "90 degrees" without mathematical singularities.

In our system, **every single step**—from the raw firmware data, through the Bluetooth packet, to the React state, into the Three.js scene—remains a Quaternion. We **never** convert to Euler angles for processing, only for human-readable logs. This guarantees the system is immune to Gimbal Lock.

---

## 4. The Runtime Pipeline

Once calibrated, the runtime loop is efficient and robust:

1.  **Input:** Receive $q_{sensor\_raw}$ from Bluetooth (High frequency, 60-100Hz).
2.  **Tare/Calibration:** Apply the calculated offset:
    $$q_{bone} = q_{sensor\_raw} \otimes q_{mounting}$$
3.  **Skeleton Update:** Update the Virtual Bone with $q_{bone}$.
    *   Since we use a hierarchy, this rotation is applied relative to the parent bone (e.g., Shin is relative to Thigh).
4.  **Render:** The mesh deforms.

By strictly adhering to this pipeline, we ensure that **arbitrary sensor placement** is mathematically neutralized, resulting in true-to-life biomechanical motion.
