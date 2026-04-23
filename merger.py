import os

def merge_backend_code(src_dir, output_file):
    # Define which file extensions you want to include. 
    # Add or remove extensions based on your backend language (e.g., .java, .go, .php, .rb)
    allowed_extensions = ('.py', '.js', '.ts', '.json', '.env.example', '.md', '.txt', '.sql', '.yml', '.yaml')
    
    # Define folders to completely ignore (to save time and avoid massive files)
    ignored_folders = {'__pycache__', 'node_modules', '.git', 'venv', '.venv', 'build', 'dist'}

    with open(output_file, 'w', encoding='utf-8') as outfile:
        # Walk through the directory tree
        for root, dirs, files in os.walk(src_dir):
            
            # Modify the dirs list in-place to skip ignored directories
            dirs[:] = [d for d in dirs if d not in ignored_folders]

            for file in files:
                # Only process files that match our allowed extensions
                if file.endswith(allowed_extensions):
                    file_path = os.path.join(root, file)
                    
                    try:
                        # Read the content of the current file
                        with open(file_path, 'r', encoding='utf-8') as infile:
                            content = infile.read()
                            
                        # Write a clear visual separator and the file path
                        outfile.write(f"\n\n{'='*80}\n")
                        outfile.write(f"FILE: {file_path}\n")
                        outfile.write(f"{'='*80}\n\n")
                        
                        # Write the file's content
                        outfile.write(content)
                        
                    except UnicodeDecodeError:
                        print(f"Skipping {file_path}: Not a valid UTF-8 text file.")
                    except Exception as e:
                        print(f"Error reading {file_path}: {e}")

if __name__ == "__main__":
    # --- CONFIGURATION ---
    # The path to your backend source folder
    source_directory = "./src"  
    
    # The name of the text file you want to generate
    output_filename = "backend.txt"  
    
    if not os.path.exists(source_directory):
        print(f"Error: The directory '{source_directory}' does not exist.")
    else:
        print(f"Merging files from '{source_directory}' into '{output_filename}'...")
        merge_backend_code(source_directory, output_filename)
        print("Merge complete!")