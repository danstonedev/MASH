/**
 * Athlete Profile Form
 * ====================
 * 
 * Form for creating and editing athlete profiles.
 * Includes all anthropometric and sport-specific fields.
 */

import { useState, useEffect } from 'react';
import {
    User, Save, X, Ruler, Scale, Activity,
    Heart, Snowflake
} from 'lucide-react';
import {
    useAthleteStore,
    type AthleteProfile,
    type Sport,
    type AthleteStatus
} from '../../store/useAthleteStore';
import { cn } from '../../lib/utils';

// ============================================================================
// TYPES
// ============================================================================

interface AthleteProfileFormProps {
    athleteId?: string;  // If editing
    onClose: () => void;
    onSave?: (profile: AthleteProfile) => void;
}

// ============================================================================
// FORM FIELD
// ============================================================================

interface FormFieldProps {
    label: string;
    unit?: string;
    children: React.ReactNode;
    optional?: boolean;
}

function FormField({ label, unit, children, optional }: FormFieldProps) {
    return (
        <div className="space-y-1">
            <label className="flex items-center gap-1 text-[10px] text-text-secondary">
                {label}
                {unit && <span className="text-text-tertiary">({unit})</span>}
                {optional && <span className="text-text-tertiary italic">optional</span>}
            </label>
            {children}
        </div>
    );
}

// ============================================================================
// SECTION
// ============================================================================

interface FormSectionProps {
    title: string;
    icon: React.ReactNode;
    children: React.ReactNode;
}

function FormSection({ title, icon, children }: FormSectionProps) {
    return (
        <div className="space-y-3">
            <h4 className="flex items-center gap-2 text-xs font-semibold text-accent border-b border-border pb-1">
                {icon}
                {title}
            </h4>
            <div className="grid grid-cols-2 gap-3">
                {children}
            </div>
        </div>
    );
}

// ============================================================================
// MAIN FORM
// ============================================================================

export function AthleteProfileForm({ athleteId, onClose, onSave }: AthleteProfileFormProps) {
    const athletes = useAthleteStore(state => state.athletes);
    const teams = useAthleteStore(state => state.teams);
    const addAthlete = useAthleteStore(state => state.addAthlete);
    const updateAthlete = useAthleteStore(state => state.updateAthlete);

    const existingAthlete = athleteId ? athletes.get(athleteId) : null;
    const isEditing = !!existingAthlete;

    // Form state
    const [firstName, setFirstName] = useState(existingAthlete?.firstName || '');
    const [lastName, setLastName] = useState(existingAthlete?.lastName || '');
    const [dateOfBirth, setDateOfBirth] = useState(existingAthlete?.dateOfBirth || '');
    const [gender, setGender] = useState<'male' | 'female' | 'other' | undefined>(existingAthlete?.gender);
    const [status, setStatus] = useState<AthleteStatus>(existingAthlete?.status || 'active');

    // Anthropometrics
    const [height, setHeight] = useState(existingAthlete?.height?.toString() || '');
    const [weight, setWeight] = useState(existingAthlete?.weight?.toString() || '');
    const [wingspan, setWingspan] = useState(existingAthlete?.wingspan?.toString() || '');
    const [legLength, setLegLength] = useState(existingAthlete?.legLength?.toString() || '');
    const [footLength, setFootLength] = useState(existingAthlete?.footLength?.toString() || '');
    const [skateSize, setSkateSize] = useState(existingAthlete?.skateSize?.toString() || '');

    // Sport
    const [sport, setSport] = useState<Sport>(existingAthlete?.sport || 'speed_skating');
    const [position, setPosition] = useState(existingAthlete?.position || '');
    const [skillLevel, setSkillLevel] = useState(existingAthlete?.skillLevel || 'intermediate');
    const [yearsExperience, setYearsExperience] = useState(existingAthlete?.yearsExperience?.toString() || '');
    const [jerseyNumber, setJerseyNumber] = useState(existingAthlete?.jerseyNumber?.toString() || '');
    const [teamId, setTeamId] = useState(existingAthlete?.teamId || '');
    const [dominantSide, setDominantSide] = useState<'left' | 'right' | undefined>(existingAthlete?.dominantSide);

    // Baselines
    const [maxJumpHeight, setMaxJumpHeight] = useState(existingAthlete?.maxJumpHeight?.toString() || '');
    const [baseStrideLength, setBaseStrideLength] = useState(existingAthlete?.baseStrideLength?.toString() || '');

    // Medical
    const [currentLimitations, setCurrentLimitations] = useState(existingAthlete?.currentLimitations || '');

    const teamList = Array.from(teams.values());

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        const profile: AthleteProfile = {
            id: athleteId || `ath-${Date.now()}`,
            userId: existingAthlete?.userId || `user-ath-${Date.now()}`,
            firstName,
            lastName,
            dateOfBirth: dateOfBirth || undefined,
            gender,
            status,
            height: height ? parseFloat(height) : undefined,
            weight: weight ? parseFloat(weight) : undefined,
            wingspan: wingspan ? parseFloat(wingspan) : undefined,
            legLength: legLength ? parseFloat(legLength) : undefined,
            footLength: footLength ? parseFloat(footLength) : undefined,
            skateSize: skateSize ? parseFloat(skateSize) : undefined,
            sport,
            position: position || undefined,
            skillLevel: skillLevel as any,
            yearsExperience: yearsExperience ? parseInt(yearsExperience) : undefined,
            jerseyNumber: jerseyNumber ? parseInt(jerseyNumber) : undefined,
            teamId: teamId || undefined,
            dominantSide,
            maxJumpHeight: maxJumpHeight ? parseFloat(maxJumpHeight) : undefined,
            baseStrideLength: baseStrideLength ? parseFloat(baseStrideLength) : undefined,
            currentLimitations: currentLimitations || undefined,
            createdAt: existingAthlete?.createdAt || Date.now(),
            updatedAt: Date.now(),
        };

        if (isEditing) {
            updateAthlete(athleteId!, profile);
        } else {
            addAthlete(profile);
        }

        onSave?.(profile);
        onClose();
    };

    const inputClass = "w-full px-2 py-1.5 text-sm bg-bg-elevated border border-border rounded focus:border-accent outline-none";
    const selectClass = "w-full px-2 py-1.5 text-sm bg-bg-elevated border border-border rounded focus:border-accent outline-none";

    return (
        <form onSubmit={handleSubmit} className="flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-glass">
                <div className="flex items-center gap-2">
                    <User className="w-5 h-5 text-accent" />
                    <h2 className="text-lg font-bold">
                        {isEditing ? 'Edit Athlete' : 'New Athlete'}
                    </h2>
                </div>
                <button type="button" onClick={onClose} className="p-1 hover:bg-white/10 rounded">
                    <X className="w-5 h-5" />
                </button>
            </div>

            {/* Form content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
                {/* Basic Info */}
                <FormSection title="Basic Information" icon={<User className="w-3 h-3" />}>
                    <FormField label="First Name">
                        <input
                            type="text"
                            value={firstName}
                            onChange={e => setFirstName(e.target.value)}
                            required
                            className={inputClass}
                        />
                    </FormField>
                    <FormField label="Last Name">
                        <input
                            type="text"
                            value={lastName}
                            onChange={e => setLastName(e.target.value)}
                            required
                            className={inputClass}
                        />
                    </FormField>
                    <FormField label="Date of Birth" optional>
                        <input
                            type="date"
                            value={dateOfBirth}
                            onChange={e => setDateOfBirth(e.target.value)}
                            className={inputClass}
                        />
                    </FormField>
                    <FormField label="Gender" optional>
                        <select value={gender || ''} onChange={e => setGender(e.target.value as any || undefined)} className={selectClass}>
                            <option value="">--</option>
                            <option value="male">Male</option>
                            <option value="female">Female</option>
                            <option value="other">Other</option>
                        </select>
                    </FormField>
                    <FormField label="Status">
                        <select value={status} onChange={e => setStatus(e.target.value as AthleteStatus)} className={selectClass}>
                            <option value="active">Active</option>
                            <option value="injured">Injured</option>
                            <option value="resting">Resting</option>
                            <option value="inactive">Inactive</option>
                        </select>
                    </FormField>
                </FormSection>

                {/* Anthropometrics */}
                <FormSection title="Anthropometrics" icon={<Ruler className="w-3 h-3" />}>
                    <FormField label="Height" unit="cm" optional>
                        <input type="number" value={height} onChange={e => setHeight(e.target.value)} className={inputClass} step="0.1" />
                    </FormField>
                    <FormField label="Weight" unit="kg" optional>
                        <input type="number" value={weight} onChange={e => setWeight(e.target.value)} className={inputClass} step="0.1" />
                    </FormField>
                    <FormField label="Wingspan" unit="cm" optional>
                        <input type="number" value={wingspan} onChange={e => setWingspan(e.target.value)} className={inputClass} step="0.1" />
                    </FormField>
                    <FormField label="Leg Length" unit="cm" optional>
                        <input type="number" value={legLength} onChange={e => setLegLength(e.target.value)} className={inputClass} step="0.1" />
                    </FormField>
                    <FormField label="Foot Length" unit="cm" optional>
                        <input type="number" value={footLength} onChange={e => setFootLength(e.target.value)} className={inputClass} step="0.1" />
                    </FormField>
                    <FormField label="Skate Size" optional>
                        <input type="number" value={skateSize} onChange={e => setSkateSize(e.target.value)} className={inputClass} step="0.5" />
                    </FormField>
                </FormSection>

                {/* Sport */}
                <FormSection title="Sport & Team" icon={<Snowflake className="w-3 h-3" />}>
                    <FormField label="Sport">
                        <select value={sport} onChange={e => setSport(e.target.value as Sport)} className={selectClass}>
                            <option value="speed_skating">Speed Skating</option>
                            <option value="hockey">Hockey</option>
                            <option value="figure_skating">Figure Skating</option>
                            <option value="other">Other</option>
                        </select>
                    </FormField>
                    <FormField label="Position" optional>
                        <input type="text" value={position} onChange={e => setPosition(e.target.value)} placeholder="e.g., Forward, Sprinter" className={inputClass} />
                    </FormField>
                    <FormField label="Skill Level">
                        <select value={skillLevel} onChange={e => setSkillLevel(e.target.value as any)} className={selectClass}>
                            <option value="beginner">Beginner</option>
                            <option value="intermediate">Intermediate</option>
                            <option value="advanced">Advanced</option>
                            <option value="elite">Elite</option>
                        </select>
                    </FormField>
                    <FormField label="Years Experience" optional>
                        <input type="number" value={yearsExperience} onChange={e => setYearsExperience(e.target.value)} className={inputClass} />
                    </FormField>
                    <FormField label="Jersey #" optional>
                        <input type="number" value={jerseyNumber} onChange={e => setJerseyNumber(e.target.value)} className={inputClass} />
                    </FormField>
                    <FormField label="Team" optional>
                        <select value={teamId} onChange={e => setTeamId(e.target.value)} className={selectClass}>
                            <option value="">None</option>
                            {teamList.map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                        </select>
                    </FormField>
                    <FormField label="Dominant Side" optional>
                        <select value={dominantSide || ''} onChange={e => setDominantSide(e.target.value as any || undefined)} className={selectClass}>
                            <option value="">--</option>
                            <option value="left">Left</option>
                            <option value="right">Right</option>
                        </select>
                    </FormField>
                </FormSection>

                {/* Performance Baselines */}
                <FormSection title="Performance Baselines" icon={<Activity className="w-3 h-3" />}>
                    <FormField label="Max Jump Height" unit="cm" optional>
                        <input type="number" value={maxJumpHeight} onChange={e => setMaxJumpHeight(e.target.value)} className={inputClass} step="0.1" />
                    </FormField>
                    <FormField label="Base Stride Length" unit="cm" optional>
                        <input type="number" value={baseStrideLength} onChange={e => setBaseStrideLength(e.target.value)} className={inputClass} step="1" />
                    </FormField>
                </FormSection>

                {/* Medical */}
                <FormSection title="Medical Notes" icon={<Heart className="w-3 h-3" />}>
                    <div className="col-span-2">
                        <FormField label="Current Limitations" optional>
                            <textarea
                                value={currentLimitations}
                                onChange={e => setCurrentLimitations(e.target.value)}
                                placeholder="Any injuries or restrictions..."
                                className={cn(inputClass, "resize-none")}
                                rows={2}
                            />
                        </FormField>
                    </div>
                </FormSection>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-glass">
                <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 text-sm text-text-secondary hover:bg-white/10 rounded"
                >
                    Cancel
                </button>
                <button
                    type="submit"
                    className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/80"
                >
                    <Save className="w-4 h-4" />
                    {isEditing ? 'Save Changes' : 'Create Athlete'}
                </button>
            </div>
        </form>
    );
}
