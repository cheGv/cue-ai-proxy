import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class AddClientScreen extends StatefulWidget {
  const AddClientScreen({super.key});

  @override
  State<AddClientScreen> createState() => _AddClientScreenState();
}

class _AddClientScreenState extends State<AddClientScreen> {
  final _supabase = Supabase.instance.client;
  final _formKey = GlobalKey<FormState>();

  // Controllers
  final _nameController = TextEditingController();
  final _diagnosisController = TextEditingController();
  final _aacDeviceController = TextEditingController();
  final _primaryLanguageController = TextEditingController();
  final _caregiverNameController = TextEditingController();
  final _caregiverPhoneController = TextEditingController();
  final _caregiverEmailController = TextEditingController();
  final _notesController = TextEditingController();

  DateTime? _dateOfBirth;
  String? _gender;
  String? _communicationModality;
  bool _isSaving = false;

  static const _genders = ['Male', 'Female', 'Other'];
  static const _modalities = [
    'Verbal',
    'Minimal Verbal',
    'Non-speaking',
    'AAC User',
    'Mixed',
  ];

  bool get _showAacDevice =>
      _communicationModality == 'AAC User' ||
      _communicationModality == 'Mixed';

  @override
  void dispose() {
    _nameController.dispose();
    _diagnosisController.dispose();
    _aacDeviceController.dispose();
    _primaryLanguageController.dispose();
    _caregiverNameController.dispose();
    _caregiverPhoneController.dispose();
    _caregiverEmailController.dispose();
    _notesController.dispose();
    super.dispose();
  }

  int? _calcAge(DateTime dob) {
    final now = DateTime.now();
    int age = now.year - dob.year;
    if (now.month < dob.month ||
        (now.month == dob.month && now.day < dob.day)) {
      age--;
    }
    return age;
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: DateTime(DateTime.now().year - 5),
      firstDate: DateTime(DateTime.now().year - 120),
      lastDate: DateTime.now(),
      builder: (context, child) => Theme(
        data: Theme.of(context).copyWith(
          colorScheme: const ColorScheme.light(primary: Colors.teal),
        ),
        child: child!,
      ),
    );
    if (picked != null) {
      setState(() => _dateOfBirth = picked);
    }
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() => _isSaving = true);

    try {
      final uid = _supabase.auth.currentUser!.id;
      final age = _dateOfBirth != null ? _calcAge(_dateOfBirth!) : null;

      await _supabase.from('clients').insert({
        'clinician_id': uid,
        'name': _nameController.text.trim(),
        'date_of_birth': _dateOfBirth?.toIso8601String().split('T').first,
        'age': age,
        'gender': _gender,
        'diagnosis': _diagnosisController.text.trim().isEmpty
            ? null
            : _diagnosisController.text.trim(),
        'communication_modality': _communicationModality,
        'aac_device': _showAacDevice && _aacDeviceController.text.trim().isNotEmpty
            ? _aacDeviceController.text.trim()
            : null,
        'uses_aac': _showAacDevice,
        'primary_language': _primaryLanguageController.text.trim().isEmpty
            ? null
            : _primaryLanguageController.text.trim(),
        'caregiver_name': _caregiverNameController.text.trim().isEmpty
            ? null
            : _caregiverNameController.text.trim(),
        'caregiver_phone': _caregiverPhoneController.text.trim().isEmpty
            ? null
            : _caregiverPhoneController.text.trim(),
        'caregiver_email': _caregiverEmailController.text.trim().isEmpty
            ? null
            : _caregiverEmailController.text.trim(),
        'additional_notes': _notesController.text.trim().isEmpty
            ? null
            : _notesController.text.trim(),
        'total_sessions': 0,
      });

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Client added successfully'),
            backgroundColor: Colors.teal,
          ),
        );
        Navigator.pop(context, true); // true = refresh roster
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Error saving client: $e'),
            backgroundColor: Colors.red.shade700,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isSaving = false);
    }
  }

  InputDecoration _fieldDecoration(String label, {String? hint, bool optional = false}) {
    return InputDecoration(
      labelText: optional ? '$label (optional)' : label,
      hintText: hint,
      filled: true,
      fillColor: Colors.grey.shade50,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: Colors.grey.shade300),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: Colors.grey.shade300),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: Colors.teal, width: 2),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: Colors.red.shade400),
      ),
      focusedErrorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: Colors.red.shade400, width: 2),
      ),
    );
  }

  Widget _sectionHeader(String title) {
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 4),
      child: Text(
        title,
        style: TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w600,
          color: Colors.teal.shade700,
          letterSpacing: 0.4,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Add Client'),
        backgroundColor: Colors.teal,
        foregroundColor: Colors.white,
      ),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            // ── Client Info ──────────────────────────────────────────
            _sectionHeader('CLIENT INFORMATION'),
            const SizedBox(height: 8),

            // Full name
            TextFormField(
              controller: _nameController,
              decoration: _fieldDecoration('Full name'),
              textCapitalization: TextCapitalization.words,
              validator: (v) =>
                  (v == null || v.trim().isEmpty) ? 'Full name is required' : null,
            ),
            const SizedBox(height: 14),

            // Date of birth
            GestureDetector(
              onTap: _pickDate,
              child: AbsorbPointer(
                child: TextFormField(
                  decoration: _fieldDecoration('Date of birth').copyWith(
                    suffixIcon: const Icon(Icons.calendar_today_outlined,
                        color: Colors.teal),
                    hintText: 'Tap to select',
                  ),
                  controller: TextEditingController(
                    text: _dateOfBirth == null
                        ? ''
                        : '${_dateOfBirth!.day.toString().padLeft(2, '0')}/'
                            '${_dateOfBirth!.month.toString().padLeft(2, '0')}/'
                            '${_dateOfBirth!.year}'
                            '  ·  Age ${_calcAge(_dateOfBirth!)}',
                  ),
                  validator: (_) =>
                      _dateOfBirth == null ? 'Date of birth is required' : null,
                ),
              ),
            ),
            const SizedBox(height: 14),

            // Gender
            DropdownButtonFormField<String>(
              value: _gender,
              decoration: _fieldDecoration('Gender', optional: true),
              items: _genders
                  .map((g) => DropdownMenuItem(value: g, child: Text(g)))
                  .toList(),
              onChanged: (v) => setState(() => _gender = v),
            ),
            const SizedBox(height: 14),

            // Diagnosis
            TextFormField(
              controller: _diagnosisController,
              decoration: _fieldDecoration('Diagnosis',
                  hint: 'e.g. ASD, CAS, Aphasia', optional: true),
            ),
            const SizedBox(height: 20),

            // ── Communication ─────────────────────────────────────────
            _sectionHeader('COMMUNICATION'),
            const SizedBox(height: 8),

            // Communication modality
            DropdownButtonFormField<String>(
              value: _communicationModality,
              decoration: _fieldDecoration('Communication modality',
                  optional: true),
              items: _modalities
                  .map((m) => DropdownMenuItem(value: m, child: Text(m)))
                  .toList(),
              onChanged: (v) => setState(() {
                _communicationModality = v;
                if (!_showAacDevice) _aacDeviceController.clear();
              }),
            ),
            const SizedBox(height: 14),

            // AAC device (conditional)
            AnimatedSize(
              duration: const Duration(milliseconds: 200),
              curve: Curves.easeInOut,
              child: _showAacDevice
                  ? Column(
                      children: [
                        TextFormField(
                          controller: _aacDeviceController,
                          decoration: _fieldDecoration('AAC device',
                              hint: 'e.g. Proloquo2Go, LAMP, PECS',
                              optional: true),
                        ),
                        const SizedBox(height: 14),
                      ],
                    )
                  : const SizedBox.shrink(),
            ),

            // Primary language
            TextFormField(
              controller: _primaryLanguageController,
              decoration:
                  _fieldDecoration('Primary language at home', optional: true),
              textCapitalization: TextCapitalization.words,
            ),
            const SizedBox(height: 20),

            // ── Parent / Caregiver ────────────────────────────────────
            _sectionHeader('PARENT / CAREGIVER'),
            const SizedBox(height: 8),

            TextFormField(
              controller: _caregiverNameController,
              decoration:
                  _fieldDecoration('Parent/caregiver name', optional: true),
              textCapitalization: TextCapitalization.words,
            ),
            const SizedBox(height: 14),

            TextFormField(
              controller: _caregiverPhoneController,
              decoration:
                  _fieldDecoration('Parent phone number', optional: true),
              keyboardType: TextInputType.phone,
            ),
            const SizedBox(height: 14),

            TextFormField(
              controller: _caregiverEmailController,
              decoration:
                  _fieldDecoration('Parent email', optional: true),
              keyboardType: TextInputType.emailAddress,
              validator: (v) {
                if (v == null || v.trim().isEmpty) return null;
                final emailRe = RegExp(r'^[^@]+@[^@]+\.[^@]+$');
                if (!emailRe.hasMatch(v.trim())) return 'Enter a valid email';
                return null;
              },
            ),
            const SizedBox(height: 20),

            // ── Notes ─────────────────────────────────────────────────
            _sectionHeader('NOTES'),
            const SizedBox(height: 8),

            TextFormField(
              controller: _notesController,
              decoration: _fieldDecoration('Additional notes', optional: true),
              maxLines: 4,
              textCapitalization: TextCapitalization.sentences,
            ),
            const SizedBox(height: 32),

            // Save button
            FilledButton(
              onPressed: _isSaving ? null : _save,
              style: FilledButton.styleFrom(
                backgroundColor: Colors.teal,
                minimumSize: const Size.fromHeight(52),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              child: _isSaving
                  ? const SizedBox(
                      height: 22,
                      width: 22,
                      child: CircularProgressIndicator(
                        strokeWidth: 2.5,
                        color: Colors.white,
                      ),
                    )
                  : const Text(
                      'Save Client',
                      style: TextStyle(fontSize: 16),
                    ),
            ),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }
}
